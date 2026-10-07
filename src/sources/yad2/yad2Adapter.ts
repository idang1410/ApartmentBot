import { listingCityMatches } from '../../core/cities.js';
import {
  BlockedError,
  type CityEntry,
  type FetchOptions,
  type Listing,
  type SavedSearch,
  type SourceAdapter,
} from '../../core/types.js';
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
 * Pages read at most. A restart forgets what was read, so the first walk goes this deep:
 * it is the catch-up after the PC was switched off. Ten pages is ~400 ads, several hours of
 * Tel Aviv's updates; an ad that sank further while the bot was down waits for the deep walk.
 */
export const MAX_PAGES = 10;

/**
 * Pages read below the top each cycle. An ad that was never bumped sinks and stays sunk, so
 * a cursor walks the rest of the feed a little at a time and wraps at the end. Tel Aviv's
 * ~170 pages take ~85 cycles.
 */
export const DEEP_PAGES_PER_CYCLE = 2;

/** Where the deep walk starts again after the last page. */
const DEEP_FIRST_PAGE = MIN_PAGES + 1;

/** Followed by a city key; the next page the deep walk reads there. */
export const DEEP_CURSOR_PREFIX = 'yad2_deep_page:';

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
  // Tokens read so far, per city. Memory is enough: it only decides how deep to read, and
  // losing it on restart is exactly what makes the first walk a catch-up. Only a poll walk
  // that finishes cleanly writes it.
  const seenByCity = new Map<string, Set<string>>();

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
      // make the next cycle stop at page 2, and a restart's catch-up would be lost for good.
      const seen = new Set(seenByCity.get(city.key));
      const collected = new Map<string, Listing>();
      let pagesRead = 0;
      let totalPages = 1;
      let finished = true;

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
        totalPages = feed.totalPages;

        const sawNew = feed.tokens.some((token) => !seen.has(token));
        for (const token of feed.tokens) seen.add(token);
        for (const listing of feed.listings) {
          if (listingCityMatches(city, listing.city)) collected.set(listing.sourceId, listing);
        }

        if (page >= feed.totalPages) break;
        if (page >= MIN_PAGES && !sawNew) break;
      }

      // The deep walk belongs to poll cycles only, and follows a top walk that finished. It
      // runs before `seen` is saved, so a block here also makes the next top walk read deep.
      let deepRead = 0;
      if (finished && !options?.preview && kv) {
        const key = `${DEEP_CURSOR_PREFIX}${city.key}`;
        let next = Math.max(Number(kv.get(key)) || DEEP_FIRST_PAGE, pagesRead + 1);
        for (let i = 0; i < DEEP_PAGES_PER_CYCLE; i++) {
          if (next > totalPages) {
            next = DEEP_FIRST_PAGE;
            if (next <= pagesRead) break;
          }
          let feed: Yad2FeedPage;
          try {
            feed = parseYad2FeedBody(await fetchPage(city, next), city.name);
          } catch (error) {
            if (error instanceof BlockedError) throw error;
            logger.warn({ err: error, city: city.key, page: next }, 'yad2 deep page failed');
            break;
          }
          deepRead++;
          totalPages = feed.totalPages;
          for (const listing of feed.listings) {
            if (listingCityMatches(city, listing.city)) collected.set(listing.sourceId, listing);
          }
          // An empty page is the end of the feed too, if the count was off.
          next = feed.tokens.length === 0 ? DEEP_FIRST_PAGE : next + 1;
          kv.set(key, String(next));
        }
      }

      if (finished && !options?.preview) seenByCity.set(city.key, seen);

      logger.debug(
        { search: search.id, city: city.key, pages: pagesRead, deepPages: deepRead, found: collected.size },
        'yad2 fetch done',
      );
      return [...collected.values()];
    },
  };
}
