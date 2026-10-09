import { classifyMatch } from '../core/filter.js';
import { CLOSED_STATUSES } from '../core/tracking.js';
import { sameFlat, type Listing, type SavedSearch } from '../core/types.js';
import type { ListingsRepo, MatchedListing } from '../db/listings.repo.js';

/** How far back /review looks. */
export const REVIEW_DAYS = 30;

export interface ReviewItem extends MatchedListing {
  search: SavedSearch;
  /** True when the chat has set a status on the flat. */
  marked: boolean;
  /** Other stored ads of the flat, older than `listing`. */
  copies: Listing[];
}

/**
 * The stored matches /review goes over: checked again against each search as
 * it is now, one item per flat, without flats marked rejected or taken,
 * unmarked ones first and each group newest first. A flat is its ads that
 * sameFlat calls 'same'; the newest is the item's listing, and a status on any
 * ad, or on a tracked ad of the flat, is the flat's. `onlyUnmarked` leaves out
 * the marked ones.
 */
export function reviewQueue(
  listings: ListingsRepo,
  searches: SavedSearch[],
  chatId: number,
  onlyUnmarked: boolean,
): ReviewItem[] {
  // Any active search may claim a listing, whichever search stored it.
  const claim = (listing: Listing) => {
    for (const search of searches) {
      const kind = classifyMatch(listing, search);
      if (kind) return { search, kind };
    }
    return null;
  };
  const groups: MatchedListing[][] = [];
  for (const m of listings.matchedRecently(chatId, REVIEW_DAYS, (listing) => claim(listing)?.kind ?? null)) {
    const group = groups.find((g) => g.some((other) => sameFlat(other.listing, m.listing) === 'same'));
    if (group) group.push(m);
    else groups.push([m]);
  }
  const tracked = listings.listTracked(chatId, true);
  const items = groups
    .map((group) => {
      const statuses = group.flatMap(({ listing }) => [
        listings.trackingOf(listing, chatId)?.status ?? null,
        ...tracked.filter((t) => sameFlat(t.listing, listing) === 'same').map((t) => t.status),
      ]);
      const closed =
        group.some(({ listing }) => listings.isClosed(listing, chatId)) ||
        statuses.some((status) => status !== null && CLOSED_STATUSES.includes(status));
      return { group, statuses, closed };
    })
    .filter(({ closed }) => !closed)
    .map(({ group: [m, ...copies], statuses }) => ({
      ...m!,
      search: claim(m!.listing)!.search,
      marked: statuses.some((status) => status !== null),
      copies: copies.map((copy) => copy.listing),
    }));
  const unmarked = items.filter((item) => !item.marked);
  return onlyUnmarked ? unmarked : [...unmarked, ...items.filter((item) => item.marked)];
}
