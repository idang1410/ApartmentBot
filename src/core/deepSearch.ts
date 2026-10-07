import { findCityByKey } from './cities.js';
import { classifyMatch } from './filter.js';
import { isCadenceDue } from './pollCycle.js';
import type { HealthTracker } from './health.js';
import type { Notifier } from './notifier.js';
import {
  BlockedError,
  SessionExpiredError,
  type CityEntry,
  type DeepStep,
  type Listing,
  type SavedSearch,
  type SourceAdapter,
} from './types.js';
import type { KvRepo } from '../db/kv.repo.js';
import type { ListingsRepo } from '../db/listings.repo.js';
import type { SearchesRepo } from '../db/searches.repo.js';
import { logger } from '../logger.js';

/** Followed by `<source>:<cityKey>`; one source's deep search of one city, as a JSON `DeepState`. */
export const DEEP_PREFIX = 'deep:';

/** No city starts its deep steps once a cycle has spent this long on them. */
export const DEEP_BUDGET_MS = 3 * 60_000;

/** Sources read through the owner's Facebook account. */
export const FACEBOOK_SOURCES = new Set(['facebook', 'facebook-marketplace']);

/**
 * Minutes between Facebook deep steps, measured from `deep_last_facebook` in kv. One step
 * runs at most, for one Facebook source, whichever cycle it falls in.
 */
export const FACEBOOK_DEEP_GAP_MINUTES = 15;
const FACEBOOK_LAST_STEP = 'deep_last_facebook';

interface DeepState {
  /** The unit the next step starts at; null once the deep search is complete. */
  next: number | null;
  total?: number;
  /** Matching listings recorded, per chat id. */
  found: Record<string, number>;
}

type KvLike = Pick<KvRepo, 'get' | 'set'>;

function readState(kv: KvLike, source: string, cityKey: string): DeepState | undefined {
  const raw = kv.get(`${DEEP_PREFIX}${source}:${cityKey}`);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as DeepState;
  } catch {
    return undefined;
  }
}

function writeState(kv: KvLike, source: string, cityKey: string, state: DeepState): void {
  kv.set(`${DEEP_PREFIX}${source}:${cityKey}`, JSON.stringify(state));
}

/** Starts a source's deep search of a city from the beginning. False when one is in progress. */
export function restartDeepSearch(kv: KvLike, source: string, cityKey: string): boolean {
  const state = readState(kv, source, cityKey);
  if (state && state.next !== null) return false;
  writeState(kv, source, cityKey, { next: 0, found: {} });
  return true;
}

interface CityPlan {
  city: CityEntry;
  searches: SavedSearch[];
  /** The sources that can deep-search the city for at least one of the searches. */
  sources: SourceAdapter[];
}

/**
 * Reads each source's whole catalogue for every watched city once, a step per source per
 * poll cycle, so regular scans only need to read back to what was already seen.
 *
 * A city with no recorded deep search starts one by itself. What it finds is recorded as
 * seen with its match kind, for /review, and never alerted: each chat gets one message per
 * source that found something, and a summary once every source is done. Progress lives in
 * kv, so a restart resumes where the last step ended.
 */
export class DeepSearch {
  constructor(
    private readonly adapters: SourceAdapter[],
    private readonly searches: SearchesRepo,
    private readonly listings: ListingsRepo,
    private readonly kv: KvRepo,
    private readonly notifier: Notifier,
    private readonly health: HealthTracker,
  ) {}

  /** One step for every unfinished source of every watched city, within DEEP_BUDGET_MS. */
  async step(): Promise<void> {
    const deadline = Date.now() + DEEP_BUDGET_MS;
    let facebookDue = isCadenceDue(this.kv.get(FACEBOOK_LAST_STEP), FACEBOOK_DEEP_GAP_MINUTES);
    for (const plan of this.plan()) {
      if (Date.now() > deadline) break;
      // A source backing off from a block sits the step out; the backoff is the health tracker's.
      const due = plan.sources.filter((a) => {
        if (!this.isRunning(a, plan.city) || this.health.get(a.name).backoffCycles > 0) return false;
        if (!FACEBOOK_SOURCES.has(a.name)) return true;
        if (!facebookDue) return false;
        facebookDue = false;
        this.kv.set(FACEBOOK_LAST_STEP, new Date().toISOString());
        return true;
      });
      if (due.length === 0) continue;

      // Concurrent, like the poll cycle: different hosts, throttled per host.
      const completed = await Promise.all(due.map((adapter) => this.stepSource(adapter, plan)));
      if (completed.some(Boolean) && plan.sources.every((a) => !this.isRunning(a, plan.city))) {
        await this.summarise(plan);
      }
    }
  }

  /** Whether any watched city has a deep search not yet complete. */
  inProgress(): boolean {
    return this.plan().some(({ city, sources }) => sources.some((a) => this.isRunning(a, city)));
  }

  /** Starts every source's deep search of every watched city over. False when one is in progress. */
  restartAll(): boolean {
    if (this.inProgress()) return false;
    for (const { city, sources } of this.plan()) {
      for (const adapter of sources) restartDeepSearch(this.kv, adapter.name, city.key);
    }
    return true;
  }

  /** One line per source and city: units read of the total, or done, and what this chat got. */
  progress(chatId: number): string[] {
    return this.plan().flatMap(({ city, sources }) =>
      sources.map((adapter) => {
        const state = readState(this.kv, adapter.name, city.key);
        const found = state?.found[chatId] ?? 0;
        const where = state?.next === null ? '✅ הושלם' : `🔄 ${state?.next ?? 0}/${state?.total ?? '?'}`;
        return `${adapter.name} · ${city.name}: ${where} · ${found} מתאימות`;
      }),
    );
  }

  private isRunning(adapter: SourceAdapter, city: CityEntry): boolean {
    return readState(this.kv, adapter.name, city.key)?.next !== null;
  }

  private plan(): CityPlan[] {
    const byCity = new Map<string, { city: CityEntry; searches: SavedSearch[] }>();
    for (const search of this.searches.listActive()) {
      for (const key of search.cityKeys) {
        const city = findCityByKey(key);
        if (!city) continue;
        const entry = byCity.get(key) ?? { city, searches: [] };
        entry.searches.push(search);
        byCity.set(key, entry);
      }
    }
    return [...byCity.values()].map(({ city, searches }) => ({
      city,
      searches,
      sources: this.adapters.filter((a) => a.deepSearch && searches.some((s) => a.supports(s, city))),
    }));
  }

  /** Runs one step and records what it found. True when it completed the source's deep search. */
  private async stepSource(adapter: SourceAdapter, { city, searches }: CityPlan): Promise<boolean> {
    const state = readState(this.kv, adapter.name, city.key) ?? { next: 0, found: {} };
    let step: DeepStep;
    try {
      step = await adapter.deepSearch!(city, state.next ?? 0);
    } catch (error) {
      // The step is not counted, so the next cycle reads the same units again.
      await this.recordFailure(adapter, error);
      return false;
    }
    const recovered = this.health.recordSuccess(adapter.name);
    if (recovered) await this.notifier.notifyOwner(recovered);

    for (const search of searches.filter((s) => adapter.supports(s, city))) {
      const kindOf = (l: Listing) => classifyMatch(l, search) ?? 'exact';
      const matching = step.listings.filter((l) => classifyMatch(l, search) !== null);
      const fresh = this.listings
        .selectUnseen(matching, search.chatId)
        .filter((l) => !this.listings.isClosed(l, search.chatId));
      const added = this.listings.seedAsSeen(fresh, search.id, search.chatId, kindOf);
      if (added > 0) state.found[search.chatId] = (state.found[search.chatId] ?? 0) + added;
    }

    state.next = step.next;
    if (step.total !== undefined) state.total = step.total;
    writeState(this.kv, adapter.name, city.key, state);
    logger.info(
      {
        source: adapter.name,
        city: city.key,
        next: step.next,
        total: step.total,
        read: step.listings.length,
      },
      'deep search step done',
    );

    if (step.next !== null) return false;
    for (const chatId of chatsOf(searches)) {
      const found = state.found[chatId] ?? 0;
      if (found === 0) continue;
      await this.notifier.notifyChat(
        chatId,
        `🔎 החיפוש המעמיק ב-${adapter.name} (${city.name}) הסתיים: ${found} דירות מתאימות. ` +
          'שלח /review new כדי לעבור עליהן.',
      );
    }
    return true;
  }

  /** Once every source of a city is done: one message per chat with the count per source. */
  private async summarise({ city, searches, sources }: CityPlan): Promise<void> {
    for (const chatId of chatsOf(searches)) {
      const counts = sources.map((a) => ({
        name: a.name,
        found: readState(this.kv, a.name, city.key)?.found[chatId] ?? 0,
      }));
      const total = counts.reduce((sum, c) => sum + c.found, 0);
      await this.notifier.notifyChat(
        chatId,
        [
          `🔎 החיפוש המעמיק ב${city.name} הסתיים בכל המקורות.`,
          ...counts.map((c) => `${c.name}: ${c.found}`),
          total > 0
            ? `סה״כ ${total} דירות מתאימות. שלח /review new כדי לעבור עליהן.`
            : 'לא נמצאו דירות מתאימות שלא ראית.',
        ].join('\n'),
      );
    }
  }

  /** The same health rules as a regular fetch: a block backs off, an expired login is said once. */
  private async recordFailure(adapter: SourceAdapter, error: unknown): Promise<void> {
    if (error instanceof SessionExpiredError) {
      const alert = this.health.recordSessionExpired(adapter.name, error.instruction);
      if (alert) await this.notifier.notifyOwner(alert);
      return;
    }
    const blocked = error instanceof BlockedError;
    logger.error({ err: error, source: adapter.name, blocked }, 'deep search step failed');
    const alert = this.health.recordFailure(adapter.name, error, blocked);
    if (alert && !adapter.bestEffort) await this.notifier.notifyOwner(alert);
  }
}

function chatsOf(searches: SavedSearch[]): number[] {
  return [...new Set(searches.map((s) => s.chatId))];
}
