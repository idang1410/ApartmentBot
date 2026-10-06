import { classifyMatch } from '../core/filter.js';
import type { Listing, SavedSearch } from '../core/types.js';
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
  // Any active search may claim a listing, whichever search stored it.
  const claim = (listing: Listing) => {
    for (const search of searches) {
      const kind = classifyMatch(listing, search);
      if (kind) return { search, kind };
    }
    return null;
  };
  const items = listings
    .matchedRecently(chatId, REVIEW_DAYS, (listing) => claim(listing)?.kind ?? null)
    .filter((m) => !listings.isClosed(m.listing, chatId))
    .map((m) => ({
      ...m,
      search: claim(m.listing)!.search,
      marked: (listings.trackingOf(m.listing, chatId)?.status ?? null) !== null,
    }));
  const unmarked = items.filter((item) => !item.marked);
  return onlyUnmarked ? unmarked : [...unmarked, ...items.filter((item) => item.marked)];
}
