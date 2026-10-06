import type { MarketSnapshot } from '../core/pollCycle.js';
import { listingFingerprint, type Listing } from '../core/types.js';
import { escapeHtml, formatPostedAt, newestFirst } from './format.js';

/** Photo cards per page; each is a separate message. */
export const CARDS_PAGE = 5;

export interface DigestOptions {
  offset: number;
  pageSize: number;
  alreadySent: (listing: Listing) => boolean;
  /** The near-miss reason for this listing, or null when it fits exactly. */
  nearMiss: (listing: Listing) => string | null;
}

/**
 * The market as a list: one line per flat with the four facts that decide a
 * click, and the link. A person scanning twenty flats wants a table, not
 * twenty photos.
 */
export function formatDigest(listings: Listing[], options: DigestOptions): string {
  return listings
    .slice(options.offset, options.offset + options.pageSize)
    .map((listing) => {
      const reason = options.nearMiss(listing);
      const marker = reason ? '🤏 ' : options.alreadySent(listing) ? '✓ ' : '';
      const price = listing.price === null ? 'מחיר לא צוין' : `${listing.price.toLocaleString('en-US')} ₪`;
      const rooms = listing.rooms === null ? null : `${listing.rooms} חד׳`;
      const place = [listing.address, listing.neighborhood]
        .filter((value): value is string => Boolean(value))
        .map(escapeHtml)
        .join(', ');
      const age = listing.postedAt ? formatPostedAt(listing.postedAt) : null;
      const facts = [price, rooms, place || null, age].filter(Boolean).join(' · ');
      const line = `${marker}${facts} - <a href="${listing.url}">פתח</a>`;
      return reason ? `${line} <i>(${escapeHtml(reason)})</i>` : line;
    })
    .join('\n');
}

/**
 * Exact matches first - the ones not yet sent before the ones already sent -
 * then the near misses, each group newest first.
 */
export function orderSnapshot(snapshot: MarketSnapshot, alreadySent: (listing: Listing) => boolean): Listing[] {
  return collapseDuplicates([
    ...newestFirst(snapshot.matching.filter((l) => !alreadySent(l))),
    ...newestFirst(snapshot.matching.filter(alreadySent)),
    ...newestFirst(snapshot.near),
  ]);
}

/**
 * One flat, one entry, however many boards carry it.
 *
 * The alert stream has collapsed cross-source duplicates since the beginning,
 * but the market list never did: `collect` pools every source and this was
 * handed the lot. On real data a 134-card sweep carried 14 flats two or three
 * times - 16 cards of the same flats, about an eighth of the list.
 *
 * Collapsing happens *after* ordering, so the copy kept is the best-ranked
 * one: an exact match outranks the same flat arriving as a near miss, and an
 * unsent copy outranks one already alerted. A listing too vague to fingerprint
 * is always kept, exactly as it is in the alert path - better a second card
 * than a flat quietly missing from the market view.
 */
function collapseDuplicates(listings: Listing[]): Listing[] {
  const seen = new Set<string>();
  const kept: Listing[] = [];

  for (const listing of listings) {
    const fingerprint = listingFingerprint(listing);
    if (fingerprint) {
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
    }
    kept.push(listing);
  }

  return kept;
}
