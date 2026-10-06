import { classifyMatch } from '../core/filter.js';
import type { SavedSearch } from '../core/types.js';
import type { ListingsRepo, MatchedListing } from '../db/listings.repo.js';

/** How far back /review looks. */
export const REVIEW_DAYS = 30;

export interface ReviewItem extends MatchedListing {
  search: SavedSearch;
  /** True when the chat has set a status on the flat. */
  marked: boolean;
}

/**
 * The stored matches /review goes over: checked again against each search as
 * it is now, without flats marked rejected or taken, unmarked ones first and
 * each group newest first. `onlyUnmarked` leaves out the marked ones.
 */
export function reviewQueue(
  listings: ListingsRepo,
  searches: SavedSearch[],
  chatId: number,
  onlyUnmarked: boolean,
): ReviewItem[] {
  const byId = new Map(searches.map((s) => [s.id, s]));
  const items = listings
    .matchedRecently(chatId, REVIEW_DAYS, (listing, searchId) => {
      const search = byId.get(searchId);
      return search ? classifyMatch(listing, search) : null;
    })
    .filter((m) => !listings.isClosed(m.listing, chatId))
    .map((m) => ({
      ...m,
      search: byId.get(m.searchId)!,
      marked: (listings.trackingOf(m.listing, chatId)?.status ?? null) !== null,
    }));
  const unmarked = items.filter((item) => !item.marked);
  return onlyUnmarked ? unmarked : [...unmarked, ...items.filter((item) => item.marked)];
}
