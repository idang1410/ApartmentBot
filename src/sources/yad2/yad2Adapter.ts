import { listingCityMatches } from '../../core/cities.js';
import {
  BlockedError,
  type CityEntry,
  type DeepStep,
  type FetchOptions,
  type Listing,
  type SavedSearch,
  type SourceAdapter,
} from '../../core/types.js';
import { restartDeepSearch } from '../../core/deepSearch.js';
import type { KvRepo } from '../../db/kv.repo.js';
import { logger } from '../../logger.js';
import { fetchText } from '../../util/http.js';
import { parseYad2FeedBody, type Yad2FeedPage } from './yad2Normalize.js';

const FEED_API = 'https://gw.yad2.co.il/realestate-feed/rent/feed';
const ITEM_API = 'https://gw.yad2.co.il/realestate-item';

/**
 * Pages read at least, once the adapter has read the city before.
 *
 * The feed is ordered by last update, and a bump counts as one, so whatever changed since
 * the last read sits at the top. One page can still be all bumps with a new ad just below
 * it; a second page is cheap insurance.
 */
export const MIN_PAGES = 2;

/**
 * Pages read at most. A walk that reaches it without meeting a read ad means the bot was
 * off long enough to miss ads further down, so the city's deep search starts again.
 */
export const MAX_PAGES = 10;

/** Followed by a city key; the tokens recent walks read there, newest first. */
export const SEEN_PREFIX = 'yad2_seen:';

/** Tokens kept per city: a few walks' worth, enough to recognise the top of the feed. */
export const SEEN_LIMIT = 1_000;

/** Pages one deep-search step reads; the gateway's throttle spaces them. */
export const DEEP_PAGES_PER_STEP = 5;

/** The deep search's last page. Tel Aviv's whole feed is ~175. */
export const DEEP_MAX_PAGES = 200;

/** One page of a city's rental feed, as the raw response body. */
export type FeedFetcher = (city: CityEntry, page: number) => Promise<string>;

/**
 * The feed URL for one page. Only `region`, `city` and `page` are ever sent: any other
 * parameter (`order=1` and `sort=1` were tried) makes the gateway's firewall answer with a
 * block record instead of data, and that record carries the caller's IP address.
 *
 * The city code is four digits, zero-padded, as Yad2's own autocomplete writes it ("0168").
 * Sent as `168`, Kfar Yona came back an empty city with HTTP 200, and so would every one of
 * the ~660 localities whose official code is below 1000.
 */
export function feedUrl(city: CityEntry, page: number): string {
  const code = String(city.yad2CityCode).padStart(4, '0');
  return `${FEED_API}?region=${city.yad2RegionCode}&city=${code}&page=${page}`;
}

/** A GET on the gateway, sent the way the site's own calls are. */
export const fetchGateway = (url: string, retries?: number): Promise<string> =>
  fetchText(url, {
    source: 'yad2',
    retries,
    profile: 'desktop',
    headers: {
      Accept: 'application/json, text/plain, */*',
      // The gateway is a different subdomain, so it checks CORS headers.
      Origin: 'https://www.yad2.co.il',
      Referer: 'https://www.yad2.co.il/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
    },
  });

export const fetchFeedPage: FeedFetcher = (city, page) => fetchGateway(feedUrl(city, page));

/** One ad's raw body; the website's own item page answers a Radware challenge. */
export const fetchItem = (token: string): Promise<string> => fetchGateway(`${ITEM_API}/${token}`, 0);

/**
 * Yad2 is Israel's largest board and the single richest source here.
 *
 * Its website answers a Radware challenge, but the gateway API the site calls is open. The
 * map endpoint this adapter used to read returned at most 200 ads per city, and a sample
 * rather than the newest: 188 of Tel Aviv's 4,769 on 2026-09-23. The feed pages through all
 * of them.
 *
 * `region` is mandatory, and a wrong one returns an empty city with HTTP 200, which is why
 * the codes come from Yad2 itself (see cities.generated.ts) and never from a guess.
 */
export function createYad2Adapter(
  fetchPage: FeedFetcher = fetchFeedPage,
  kv?: Pick<KvRepo, 'get' | 'set'>,
): SourceAdapter {
  // Tokens read so far, per city, kept in kv so a restart does not walk to MAX_PAGES.
  // Only a poll walk that finishes cleanly writes them.
  const memory = new Map<string, string>();
  const store = kv ?? {
    get: (k: string) => memory.get(k),
    set: (k: string, v: string) => void memory.set(k, v),
  };
  const readSeen = (cityKey: string): string[] => {
    try {
      const value: unknown = JSON.parse(store.get(`${SEEN_PREFIX}${cityKey}`) ?? '[]');
      return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
    } catch {
      return [];
    }
  };

  return {
    name: 'yad2',
    cadenceMinutes: 0,

    supports(_search: SavedSearch, city: CityEntry): boolean {
      return Boolean(city.yad2CityCode && city.yad2RegionCode);
    },

    async fetchListings(search: SavedSearch, city: CityEntry, options?: FetchOptions): Promise<Listing[]> {
      if (!city.yad2CityCode || !city.yad2RegionCode) return [];

      // Every walk works on a copy, and only a poll walk that ends on its own stop condition
      // saves it back. A preview's listings never reach the alert path, and a walk cut short
      // by an error or a block never read the pages below: counting either as read would
      // make the next cycle stop at page 2 and lose the catch-up.
      const previous = readSeen(city.key);
      const seen = new Set(previous);
      const walked: string[] = [];
      const collected = new Map<string, Listing>();
      let pagesRead = 0;
      let finished = true;
      let caughtUp = false;

      for (let page = 1; page <= MAX_PAGES; page++) {
        let feed: Yad2FeedPage;
        try {
          feed = parseYad2FeedBody(await fetchPage(city, page), city.name);
        } catch (error) {
          // A block always surfaces so the source backs off, and so does a failed first
          // page, or the city would just look empty. A later page is worth losing instead.
          if (page === 1 || error instanceof BlockedError) throw error;
          logger.warn({ err: error, city: city.key, page }, 'yad2 page failed, keeping earlier pages');
          finished = false;
          break;
        }
        pagesRead = page;

        const sawNew = feed.tokens.some((token) => !seen.has(token));
        for (const token of feed.tokens) {
          seen.add(token);
          walked.push(token);
        }
        for (const listing of feed.listings) {
          if (listingCityMatches(city, listing.city)) collected.set(listing.sourceId, listing);
        }

        if (page >= feed.totalPages || (page >= MIN_PAGES && !sawNew)) {
          caughtUp = true;
          break;
        }
      }

      if (finished && !options?.preview) {
        const kept = new Set(walked);
        const tokens = [...kept, ...previous.filter((t) => !kept.has(t))].slice(0, SEEN_LIMIT);
        store.set(`${SEEN_PREFIX}${city.key}`, JSON.stringify(tokens));
        // With no tokens stored, a deep walk is the first read, not a gap.
        if (!caughtUp && previous.length > 0 && restartDeepSearch(store, 'yad2', city.key)) {
          logger.info({ city: city.key }, 'yad2 walk found no read ads, deep search scheduled');
        }
      }

      logger.debug(
        { search: search.id, city: city.key, pages: pagesRead, found: collected.size },
        'yad2 fetch done',
      );
      return [...collected.values()];
    },

    async deepSearch(city: CityEntry, from: number): Promise<DeepStep> {
      const collected = new Map<string, Listing>();
      let read = from;
      let total = DEEP_MAX_PAGES;
      let ended = false;
      for (let i = 0; i < DEEP_PAGES_PER_STEP && !ended; i++) {
        const feed = parseYad2FeedBody(await fetchPage(city, read + 1), city.name);
        read++;
        total = Math.min(feed.totalPages, DEEP_MAX_PAGES);
        for (const listing of feed.listings) {
          if (listingCityMatches(city, listing.city)) collected.set(listing.sourceId, listing);
        }
        // An empty page is the end of the feed too, if the count was off.
        ended = read >= total || feed.tokens.length === 0;
      }
      return { listings: [...collected.values()], next: ended ? null : read, total };
    },
  };
}
