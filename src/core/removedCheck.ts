import { escapeHtml } from '../bot/format.js';
import { reviewQueue } from '../bot/review.js';
import type { KvRepo } from '../db/kv.repo.js';
import type { ListingsRepo } from '../db/listings.repo.js';
import type { SearchesRepo } from '../db/searches.repo.js';
import { logger } from '../logger.js';
import { fetchItem } from '../sources/yad2/yad2Adapter.js';
import type { Notifier } from './notifier.js';
import { isCadenceDue } from './pollCycle.js';
import { CLOSED_STATUSES } from './tracking.js';
import { BlockedError, type Listing } from './types.js';

/** When the last check began, as an ISO timestamp. */
export const REMOVED_CHECK_KEY = 'yad2_removed_check';

/** Ads checked per run. The gateway's host throttle spaces the requests. */
export const REMOVED_CHECK_CAP = 150;

export const REMOVED_NOTE = 'המודעה הוסרה מיד2';

/** fetchText throws `HTTP <status> for <url>`; the gateway answers 404 only for a removed ad. */
const isNotFound = (error: unknown): boolean => error instanceof Error && error.message.startsWith('HTTP 404 ');

export interface RemovedCheckDeps {
  searches: SearchesRepo;
  listings: ListingsRepo;
  kv: KvRepo;
  notifier: Pick<Notifier, 'notifyChat'>;
}

/**
 * At most once a day, asks Yad2 for each chat's open Yad2 ads: the /review set and the
 * tracked flats not rejected or taken. A removed ad with no status becomes taken; one the
 * chat set a status on keeps it, gets REMOVED_NOTE once, and is reported to the chat.
 * Any answer but a 404 changes nothing; a block ends the run.
 */
export async function checkRemovedYad2(
  deps: RemovedCheckDeps,
  fetch: (token: string) => Promise<string> = fetchItem,
  now = Date.now(),
): Promise<void> {
  if (!isCadenceDue(deps.kv.get(REMOVED_CHECK_KEY), 24 * 60, now)) return;
  deps.kv.set(REMOVED_CHECK_KEY, new Date(now).toISOString());

  const active = deps.searches.listActive();
  let budget = REMOVED_CHECK_CAP;
  for (const chatId of new Set(active.map((s) => s.chatId))) {
    const candidates = new Map<string, { listing: Listing; marked: boolean }>();
    for (const item of reviewQueue(deps.listings, active.filter((s) => s.chatId === chatId), chatId, false)) {
      if (item.listing.source === 'yad2') candidates.set(item.listing.sourceId, item);
    }
    for (const t of deps.listings.listTracked(chatId, false)) {
      if (t.listing.source !== 'yad2' || candidates.has(t.listing.sourceId)) continue;
      if (t.status && CLOSED_STATUSES.includes(t.status)) continue;
      candidates.set(t.listing.sourceId, { listing: t.listing, marked: t.status !== null });
    }

    const pursued: Listing[] = [];
    for (const { listing, marked } of candidates.values()) {
      if (budget-- <= 0) break;
      try {
        await fetch(listing.sourceId);
        continue;
      } catch (error) {
        if (!isNotFound(error)) {
          logger.warn({ err: error, sourceId: listing.sourceId }, 'yad2 removed check failed');
          if (error instanceof BlockedError) budget = 0;
          continue;
        }
      }
      const id = deps.listings.track(listing, chatId);
      if (!marked) {
        deps.listings.setStatus(id, chatId, 'taken');
        continue;
      }
      if (deps.listings.tracked(id, chatId)?.notes.some((n) => n.text === REMOVED_NOTE)) continue;
      deps.listings.addNote(id, chatId, REMOVED_NOTE);
      pursued.push(listing);
    }

    if (pursued.length > 0) {
      const lines = pursued.map(
        (l) =>
          `• ${escapeHtml(l.address ?? l.city)}, ${l.price === null ? 'מחיר לא צוין' : `${l.price.toLocaleString('en-US')} ₪`} - ` +
          `<a href="${escapeHtml(l.url)}">מודעה</a>`,
      );
      await deps.notifier.notifyChat(chatId, `🚫 מודעות שהוסרו מיד2, של דירות שסימנת:\n${lines.join('\n')}`);
    }
  }
}
