import { findCityByKey } from './cities.js';
import { classifyMatch } from './filter.js';
import type { HealthTracker } from './health.js';
import type { Notifier } from './notifier.js';
import {
  BlockedError,
  SessionExpiredError,
  type CityEntry,
  type Listing,
  type MatchKind,
  type SavedSearch,
  type SourceAdapter,
} from './types.js';
import { KV_KEYS, type KvRepo } from '../db/kv.repo.js';

/**
 * Prefix for the per-source "last ran at" timestamps, one key per adapter.
 * Kept out of KV_KEYS because the suffix is the adapter name, not a constant.
 */
const SOURCE_LAST_RUN = 'source_last_run:';

/**
 * Prefix for per-search sequence baselines, keyed `<searchId>:<source>:<cityKey>`: the
 * highest creation sequence a source showed the first time the search read that city.
 */
const SEQUENCE_BASELINE = 'seq_baseline:';

/**
 * Prefix for each source's newest sequence seen by any poll cycle, in any city. Yad2's ad
 * numbers are one nationwide counter, so this stands in where a search has no baseline for
 * a city yet: a small town with no ads when the search began would otherwise file its first
 * ad as back catalogue and never alert on it. Written only at the end of a poll cycle, so a
 * preview never moves it and a city read later in the same cycle is judged fairly.
 */
const SEQUENCE_HIGH = 'seq_high:';

/**
 * How long a whole preview may spend fetching before it answers with what it
 * has. Only /latest and /add seeding are bounded this way; the poll cycle runs
 * unattended and can afford to wait.
 *
 * A model-read source takes tens of seconds, and `util/retry` gives it three
 * attempts at a 45-second timeout apiece - so one unlucky source could hold a
 * /latest for well over two minutes while the person watched nothing happen.
 * Forty-five seconds buys every source one honest attempt and abandons the
 * retries.
 */
export const PREVIEW_BUDGET_MS = 45_000;

/**
 * Stops waiting for `work` once the deadline passes.
 *
 * The fetch itself keeps running - there is nothing to cancel it with - but
 * its result is no longer awaited, so a slow source costs the preview nothing
 * beyond the budget it was given.
 */
function withDeadline<T>(work: Promise<T>, deadline: number, label: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(new Error(`${label}: no time left in the preview budget`));
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: exceeded the ${remaining}ms left of the preview budget`)),
      remaining,
    );
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Whether a source's cadence has elapsed, given when it last ran.
 *
 * Pure and exported so the rule can be tested without standing up a whole
 * cycle. `lastRunIso` being absent means "never run", which is due now.
 */
export function isCadenceDue(
  lastRunIso: string | undefined,
  cadenceMinutes: number,
  now: number = Date.now(),
): boolean {
  if (cadenceMinutes <= 0) return true;
  if (!lastRunIso) return true;

  const elapsed = now - Date.parse(lastRunIso);
  // A clock that went backwards, or an unreadable value, must not wedge a
  // source off forever.
  if (Number.isNaN(elapsed) || elapsed < 0) return true;

  // A minute of slack, so jitter in the schedule cannot push a source that is
  // a second short of due into waiting a whole extra cycle.
  return elapsed >= cadenceMinutes * 60_000 - 60_000;
}

/**
 * Picks out the listings a search should record silently, because the source created them
 * before the search started watching the city. Judged by the source's creation sequence
 * (Yad2's ad number).
 *
 * First sight used to be enough: a source returned its whole back catalogue once, and that
 * was seeded. Yad2's feed cannot do that (Tel Aviv's catalogue is 173 pages), and owners
 * bump old ads back to the top, where they would look new. A listing at or below the
 * baseline is back catalogue however recently it was bumped; with no baseline yet, every
 * sequenced listing is. Listings without a sequence are left to the ordinary rules.
 */
export function splitBySequence(
  listings: Listing[],
  baselineOf: (source: string) => number | undefined,
): { backCatalogue: Listing[]; highest: Map<string, number> } {
  const backCatalogue: Listing[] = [];
  const highest = new Map<string, number>();

  for (const listing of listings) {
    if (listing.sequence === undefined) continue;
    highest.set(listing.source, Math.max(highest.get(listing.source) ?? 0, listing.sequence));
    const baseline = baselineOf(listing.source);
    if (baseline === undefined || listing.sequence <= baseline) backCatalogue.push(listing);
  }

  return { backCatalogue, highest };
}

/** Identifies a listing within one cycle; a source's ids are only unique within that source. */
function listingKey(listing: Listing): string {
  return `${listing.source}\u0000${listing.sourceId}`;
}
import type { ListingsRepo } from '../db/listings.repo.js';
import type { SearchesRepo } from '../db/searches.repo.js';
import { logger } from '../logger.js';

export interface CycleResult {
  searchesPolled: number;
  listingsFetched: number;
  newListings: number;
  priceDrops: number;
  notificationsSent: number;
  failures: string[];
}

/**
 * Runs one sweep: every active search against every source that supports it,
 * then queues whatever is new and sends whatever is queued.
 *
 * A source that throws is recorded and skipped; it never aborts the sweep.
 */
export class PollCycle {
  private cycleNumber = 0;

  constructor(
    private readonly adapters: SourceAdapter[],
    private readonly searches: SearchesRepo,
    private readonly listings: ListingsRepo,
    private readonly kv: KvRepo,
    private readonly notifier: Notifier,
    private readonly health: HealthTracker,
  ) {}

  /**
   * Whether a source's cadence has elapsed since it last ran.
   *
   * Measured against the clock and stored in the database, not counted in
   * cycles. The cycle counter lived only in memory, so every restart reset it
   * to one and made *every* source run, however slow its cadence: a
   * once-a-day source fetched on all five of a day's restarts. Madlan, which
   * is polled daily precisely because it rate-limits, was hit five times over
   * and blocked the IP.
   *
   * A source that has never run is still due immediately, so adding one does
   * not mean waiting out its full interval first.
   */
  private isDue(adapter: SourceAdapter): boolean {
    return isCadenceDue(
      this.kv.get(`${SOURCE_LAST_RUN}${adapter.name}`),
      adapter.cadenceMinutes,
    );
  }

  async run(): Promise<CycleResult> {
    this.cycleNumber++;
    const result: CycleResult = {
      searchesPolled: 0,
      listingsFetched: 0,
      newListings: 0,
      priceDrops: 0,
      notificationsSent: 0,
      failures: [],
    };

    if (this.kv.getBoolean(KV_KEYS.globalPaused)) {
      logger.info('cycle skipped: bot is paused');
      return result;
    }

    // Eligibility is decided once per cycle, not once per search: the backoff
    // counter must tick down with cycles, however many searches are saved.
    const eligible = this.adapters.filter((a) => this.isDue(a) && !this.health.shouldSkip(a.name));
    for (const adapter of eligible) {
      this.kv.set(`${SOURCE_LAST_RUN}${adapter.name}`, new Date().toISOString());
    }

    // One fetch per city per cycle, reused by every search that covers it.
    const cityCache = new Map<string, Listing[]>();

    const active = this.searches.listActive();
    for (const search of active) {
      const cities = search.cityKeys.map(findCityByKey).filter((c) => c !== undefined);
      if (cities.length === 0) {
        logger.error(
          { search: search.id, cities: search.cityKeys },
          'saved search names no known city',
        );
        continue;
      }

      result.searchesPolled++;
      // A search may cover several cities; each is fetched in turn and the
      // results pooled before filtering. Cities are fetched once per cycle and
      // shared between searches - two people watching Modi'in, or one person
      // with two price bands, should not cost two sweeps of every source.
      const fetched: Listing[] = [];
      const backCatalogue = new Set<string>();
      for (const city of cities) {
        let listings = cityCache.get(city.key);
        if (!listings) {
          listings = await this.fetchForSearch(search, city, eligible, result);
          cityCache.set(city.key, listings);
        }
        fetched.push(...listings);
        // Per city, before pooling: a baseline belongs to one search reading one city.
        for (const old of this.backCatalogueFor(search, city.key, listings)) {
          backCatalogue.add(listingKey(old));
        }
      }
      // Comparisons use everything on the market, not just what matched the
      // owner's price band - otherwise every listing looks average.
      this.notifier.setMarket(fetched);
      // Near misses travel with the exact matches; the recorded kind is what
      // makes the eventual alert say "כמעט מתאים".
      const kindOf = (l: Listing): MatchKind => classifyMatch(l, search) ?? 'exact';
      const matching = fetched.filter((l) => classifyMatch(l, search) !== null);
      const unseen = this.listings.selectUnseen(matching, search.chatId);

      // A source being polled for the first time returns its whole back
      // catalogue, which is not news - those ads may be years old, and no
      // source publishes a reliable date to filter them by. So the first
      // sighting of a source is recorded silently, exactly as a new search is
      // seeded, and only what appears afterwards is treated as new.
      const known = this.listings.knownSources(search.chatId);

      // The back catalogue of the search's first read of a city: recorded, never alerted.
      const oldNews = unseen.filter((l) => backCatalogue.has(listingKey(l)));
      if (oldNews.length > 0) {
        this.listings.seedAsSeen(oldNews, search.id, search.chatId, kindOf);
        logger.info(
          { search: search.id, count: oldNews.length },
          'recorded older listings without alerting',
        );
      }
      const current = unseen.filter((l) => !backCatalogue.has(listingKey(l)));

      const firstSighting = current.filter((l) => !known.has(l.source));
      // A flat the owner rejected or saw taken is recorded but never alerted again.
      const closed = current.filter((l) => known.has(l.source) && this.listings.isClosed(l, search.chatId));
      if (closed.length > 0) this.listings.seedAsSeen(closed, search.id, search.chatId, kindOf);
      const genuinelyNew = current.filter((l) => known.has(l.source) && !closed.includes(l));

      if (firstSighting.length > 0) {
        this.listings.seedAsSeen(firstSighting, search.id, search.chatId, kindOf);
        const sources = [...new Set(firstSighting.map((l) => l.source))];
        logger.info(
          { search: search.id, sources, count: firstSighting.length },
          'seeded new source without alerting',
        );
        await this.notifier.notifyChat(
          search.chatId,
          `🆕 מקור חדש: ${sources.join(', ')} - סימנתי ${firstSighting.length} מודעות קיימות כנראות. ` +
            `מכאן תקבל התראה רק על חדשות.`,
        );
      }

      if (genuinelyNew.length > 0) {
        this.listings.recordPending(genuinelyNew, search.id, search.chatId, kindOf);
        result.newListings += genuinelyNew.length;
        logger.info({ search: search.id, count: genuinelyNew.length }, 'queued new listings');
      }

      // A flat that was too expensive last week may be in budget today.
      const drops = this.listings.findPriceDrops(matching, search.chatId);
      for (const drop of drops) {
        await this.notifier.sendPriceDrop(drop.listing, drop.previousPrice, search.id);
      }
      if (drops.length > 0) {
        result.priceDrops += drops.length;
        logger.info({ search: search.id, count: drops.length }, 'reported price drops');
      }
    }

    // Only now, once every search was judged against the previous cycle's mark.
    this.raiseSequenceHigh([...cityCache.values()].flat());

    result.notificationsSent = await this.notifier.flushPending();
    this.kv.set(KV_KEYS.lastCycleAt, new Date().toISOString());

    // Once a day's worth of cycles, drop ids too old to reappear.
    if (this.cycleNumber % 96 === 0) {
      const pruned = this.listings.pruneOlderThanMonths(6);
      if (pruned > 0) logger.info({ pruned }, 'pruned old listing ids');
    }

    return result;
  }

  private async fetchForSearch(
    search: SavedSearch,
    city: CityEntry,
    eligible: SourceAdapter[],
    result: CycleResult,
  ): Promise<Listing[]> {
    const active = eligible.filter((a) => a.supports(search, city));

    // Sources are fetched concurrently. They are different hosts, and the HTTP
    // layer throttles per host, so politeness is unaffected - but the sources
    // read by the model take tens of seconds each, and running them in
    // sequence stretched a full sweep to six minutes.
    const settled = await Promise.allSettled(
      active.map(async (adapter) => ({
        adapter,
        listings: await adapter.fetchListings(search, city),
      })),
    );

    const collected: Listing[] = [];

    for (const [index, outcome] of settled.entries()) {
      const adapter = active[index];
      if (!adapter) continue;

      if (outcome.status === 'fulfilled') {
        collected.push(...outcome.value.listings);
        result.listingsFetched += outcome.value.listings.length;

        const recovered = this.health.recordSuccess(adapter.name);
        // A best-effort source that comes back IS worth announcing - that is
        // the whole point of retrying it.
        if (recovered) await this.notifier.notifyOwner(recovered);
        continue;
      }

      const error = outcome.reason;

      // A login the owner must renew: tell them once, with the command, and
      // let the source wait. Nothing else in the cycle is affected.
      if (error instanceof SessionExpiredError) {
        logger.error({ source: adapter.name, search: search.id }, 'source session expired');
        result.failures.push(`${adapter.name}: ${error.message}`);
        const alert = this.health.recordSessionExpired(adapter.name, error.instruction);
        if (alert) await this.notifier.notifyOwner(alert);
        continue;
      }

      const blocked = error instanceof BlockedError;
      logger.error(
        { err: error, source: adapter.name, search: search.id, blocked },
        'source fetch failed',
      );
      result.failures.push(`${adapter.name}: ${error instanceof Error ? error.message : error}`);

      const alert = this.health.recordFailure(adapter.name, error, blocked);
      if (alert && !adapter.bestEffort) await this.notifier.notifyOwner(alert);
    }

    return collected;
  }

  /**
   * The listings from one city fetch to record silently for this search: the back catalogue
   * of the first read, which also sets the search's baseline for each sequenced source.
   * Afterwards nothing is held back, so an old ad bumped back into view alerts once.
   * A baseline never moves: an ad created after it that does not match today and
   * gets cheaper next week must still alert then.
   */
  private backCatalogueFor(search: SavedSearch, cityKey: string, listings: Listing[]): Listing[] {
    const keyOf = (source: string) => `${SEQUENCE_BASELINE}${search.id}:${source}:${cityKey}`;
    const { backCatalogue, highest } = splitBySequence(
      listings,
      (source) => this.readBaseline(keyOf(source)) ?? this.readBaseline(`${SEQUENCE_HIGH}${source}`),
    );
    const firstRead = new Set<string>();
    for (const [source, top] of highest) {
      if (this.readBaseline(keyOf(source)) === undefined) {
        this.kv.set(keyOf(source), String(top));
        firstRead.add(source);
      }
    }
    return backCatalogue.filter((l) => firstRead.has(l.source));
  }

  /** Raises each source's nationwide newest-sequence mark from this cycle's fetches. */
  private raiseSequenceHigh(listings: Listing[]): void {
    const { highest } = splitBySequence(listings, () => undefined);
    for (const [source, top] of highest) {
      const key = `${SEQUENCE_HIGH}${source}`;
      if (top > (this.readBaseline(key) ?? 0)) this.kv.set(key, String(top));
    }
  }

  /** A stored baseline. An unreadable one counts as absent, so it is re-established rather than trusted. */
  private readBaseline(key: string): number | undefined {
    const stored = this.kv.get(key);
    if (stored === undefined) return undefined;
    const value = Number(stored);
    return Number.isFinite(value) ? value : undefined;
  }

  /**
   * First run for a new search: record everything currently listed as already
   * seen, so the owner only hears about what appears from now on.
   */
  async seedSearch(search: SavedSearch): Promise<{ seeded: number; snapshot: MarketSnapshot }> {
    const cityCache = new Map<string, Listing[]>();
    const snapshot = await this.collect(search, cityCache);
    // Baselines are set now, so the very first cycle can already alert on anything newer.
    for (const [cityKey, listings] of cityCache) this.backCatalogueFor(search, cityKey, listings);
    const seeded = this.listings.seedAsSeen(
      [...snapshot.matching, ...snapshot.near],
      search.id,
      search.chatId,
      (l) => classifyMatch(l, search) ?? 'exact',
    );
    // The snapshot goes back so the caller can show the market without a
    // second sweep of every source.
    return { seeded, snapshot };
  }

  /**
   * Everything on offer right now, ignoring what has already been notified.
   * Backs /latest, which answers "is my search too narrow?" - a question the
   * alert stream cannot answer, because it stays silent either way.
   */
  async preview(search: SavedSearch): Promise<MarketSnapshot> {
    return this.collect(search);
  }

  /**
   * Previews several searches with each city fetched once. Two searches on
   * Modi'in - one person with two price bands - must not cost two sweeps.
   */
  async previewAll(
    searches: SavedSearch[],
    budgetMs = PREVIEW_BUDGET_MS,
  ): Promise<Map<number, MarketSnapshot>> {
    const deadline = Date.now() + budgetMs;
    const cityCache = new Map<string, Listing[]>();
    const snapshots = new Map<number, MarketSnapshot>();
    for (const search of searches) {
      snapshots.set(search.id, await this.collect(search, cityCache, deadline));
    }
    return snapshots;
  }

  private async collect(
    search: SavedSearch,
    cityCache = new Map<string, Listing[]>(),
    deadline = Date.now() + PREVIEW_BUDGET_MS,
  ): Promise<MarketSnapshot> {
    const cities = search.cityKeys.map(findCityByKey).filter((c) => c !== undefined);

    const all: Listing[] = [];
    for (const city of cities) {
      let listings = cityCache.get(city.key);
      if (!listings) {
        listings = await this.fetchCity(search, city, deadline);
        cityCache.set(city.key, listings);
      }
      all.push(...listings);
    }

    return {
      matching: all.filter((l) => classifyMatch(l, search) === 'exact'),
      near: all.filter((l) => classifyMatch(l, search) === 'near'),
      all,
    };
  }

  /** Every source that covers the city, fetched concurrently; failures are logged, not thrown. */
  private async fetchCity(
    search: SavedSearch,
    city: CityEntry,
    deadline: number,
  ): Promise<Listing[]> {
    // Concurrent, like the poll cycle: /latest waits on a person, and one slow
    // source should not hold up the other eight.
    //
    // The health check is the same one `run` applies, and leaving it out here
    // was a real bug rather than a shortcut: every /latest and every /add
    // re-probed Madlan while it was serving bot-protection pages, which is
    // precisely what deepens a block - and cost the person 15-40 seconds of
    // waiting for a source that has never returned a single listing.
    const active = this.adapters.filter(
      (adapter) => adapter.supports(search, city) && !this.health.shouldSkip(adapter.name),
    );
    const settled = await Promise.allSettled(
      active.map((adapter) =>
        withDeadline(adapter.fetchListings(search, city, { preview: true }), deadline, adapter.name),
      ),
    );

    const listings: Listing[] = [];
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        listings.push(...outcome.value);
        return;
      }
      logger.error(
        { err: outcome.reason, source: active[index]?.name, city: city.key },
        'listing fetch failed',
      );
    });
    return listings;
  }
}

/** What is on the market for one search right now: exact fits, near misses, everything. */
export interface MarketSnapshot {
  matching: Listing[];
  near: Listing[];
  all: Listing[];
}
