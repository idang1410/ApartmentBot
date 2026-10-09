import type { CityEntry, DeepStep, Listing, SavedSearch, SourceAdapter } from '../../core/types.js';
import { logger } from '../../logger.js';
import { fetchText } from '../../util/http.js';
import { normalizeMadlanBulletins, type MadlanBulletin } from './madlanNormalize.js';

/**
 * Madlan's GraphQL endpoint.
 *
 * Its HTML pages are unreadable - PerimeterX answers a bot page whatever we
 * do: plain fetch, headless Chrome, real headed Chrome with a warm-up, all
 * 403. So is `/api2`, which returns PerimeterX's own `sorry a1`. `/api3` is
 * not protected at all: it answers an ordinary POST with no cookie and no
 * browser, and has introspection switched on.
 *
 * That is the same shape as Yad2, whose site is behind Radware while its
 * gateway API is open, and it is why this source is a JSON adapter now
 * instead of a scraper.
 */
const API = 'https://www.madlan.co.il/api3';

/**
 * The whole country, newest first - there is no city filter.
 *
 * `userPreferences.location` is the documented place for one, but every
 * candidate field name is rejected by a private server-side allowlist, and
 * the query is not in the JS bundles to copy because the listing pages are
 * server-rendered. What does work is sorting: `sortType: DATE` returns the
 * most recently updated listings in Israel, which is exactly what a bot that
 * only alerts on new listings needs. The city is matched after the fetch.
 */
const QUERY = `query($q: SearchBulletinQueryInput!) {
  searchBulletinWithUserPreferences(searchQuery: $q) {
    total
    bulletins {
      id price beds area floor dealType lastUpdated sellerType description
      addressDetails { city neighbourhood streetName streetNumber }
      locationPoint { lat lng }
      amenities { secureRoom miklat mamak }
      images { imageUrl }
    }
  }
}`;

/** Rows per request. 100 is what the site itself asks for. */
const PAGE_SIZE = 100;

/**
 * How many pages to walk. Six covers roughly four days of nationwide churn,
 * measured against live data, against a cadence of a few minutes - so a
 * listing would have to be missed for days running to be lost. Pages are
 * fetched in sequence and stop early once they run past `MAX_AGE_DAYS`.
 */
const MAX_PAGES = 6;

/** No point paging past what the age filter would reject anyway. */
const MAX_AGE_DAYS = 7;

/** Pages one deep-search step reads. */
const DEEP_PAGES_PER_STEP = 3;

/** The deep search ends at the first page older than this, or at DEEP_MAX_PAGES. */
const DEEP_MAX_AGE_DAYS = 30;
const DEEP_MAX_PAGES = 200;

/**
 * Deep-search pages by number, so each city's deep search reuses the nationwide pages
 * another city read within DEEP_REUSE_MS.
 */
const deepPages = new Map<number, { at: number; bulletins: MadlanBulletin[] }>();
const DEEP_REUSE_MS = 30 * 60_000;

/**
 * The last nationwide sweep, reused across cities within one poll.
 *
 * The feed is the whole country and cannot be narrowed, so asking again for
 * each city fetches exactly the same pages: three cities meant eighteen
 * requests for six pages of data. `PollCycle` caches per city, which cannot
 * help a source whose result does not depend on the city - so the sharing has
 * to happen here.
 *
 * Deliberately in memory and deliberately short: a restart simply fetches
 * again, and the window is well under the cadence so a sweep is never served
 * data from a previous one.
 */
let recent: { at: number; bulletins: MadlanBulletin[] } | null = null;

/** How long one nationwide sweep may be reused. Comfortably below the cadence. */
const REUSE_MS = 2 * 60_000;

/** Test seam: forget the cached sweep. */
export function resetMadlanCache(): void {
  recent = null;
  deepPages.clear();
}

export const madlanAdapter: SourceAdapter = {
  name: 'madlan',
  // Each sweep is a handful of JSON requests covering every city at once, so
  // it is far cheaper than the old per-city page scrape - but it is still the
  // whole country per call, so it runs on its own modest cadence rather than
  // every cycle.
  cadenceMinutes: 15,

  supports(): boolean {
    return true;
  },

  async fetchListings(search: SavedSearch, city: CityEntry): Promise<Listing[]> {
    const bulletins = await newestNationwide();
    const listings = normalizeMadlanBulletins(bulletins, city);

    logger.debug(
      { search: search.id, city: city.key, scanned: bulletins.length, found: listings.length },
      'madlan fetch complete',
    );
    return listings;
  },

  async deepSearch(city: CityEntry, from: number): Promise<DeepStep> {
    const cutoff = Date.now() - DEEP_MAX_AGE_DAYS * 86_400_000;
    const listings: Listing[] = [];
    let page = from;
    let ended = false;
    while (!ended && page < from + DEEP_PAGES_PER_STEP) {
      let cached = deepPages.get(page);
      if (!cached || Date.now() - cached.at >= DEEP_REUSE_MS) {
        cached = { at: Date.now(), bulletins: await readPage(page) };
        deepPages.set(page, cached);
      }
      const { bulletins } = cached;
      page++;
      listings.push(...normalizeMadlanBulletins(bulletins, city));
      const last = bulletins.at(-1)?.lastUpdated;
      ended =
        bulletins.length < PAGE_SIZE ||
        (typeof last === 'string' && Date.parse(last) < cutoff) ||
        page >= DEEP_MAX_PAGES;
    }
    return { listings, next: ended ? null : page };
  },
};

/** The newest listings in the country, fetched once and shared between cities. */
async function newestNationwide(): Promise<MadlanBulletin[]> {
  if (recent && Date.now() - recent.at < REUSE_MS) return recent.bulletins;

  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  const collected: MadlanBulletin[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const bulletins = await readPage(page);
    if (bulletins.length === 0) break;

    collected.push(...bulletins);

    // The feed is newest first, so once a page ends older than the age filter
    // allows, nothing after it can matter.
    const last = bulletins.at(-1)?.lastUpdated;
    if (typeof last === 'string' && Date.parse(last) < cutoff) break;
    if (bulletins.length < PAGE_SIZE) break;
  }

  recent = { at: Date.now(), bulletins: collected };
  return collected;
}

/** One page of the nationwide feed, newest first. */
async function readPage(page: number): Promise<MadlanBulletin[]> {
  const body = await fetchText(API, {
    source: 'madlan',
    profile: 'desktop',
    json: {
      query: QUERY,
      variables: {
        q: {
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          sortType: 'DATE',
          sortOrder: 'DESC',
          // Both lists must be present: the input marks them non-null.
          userPreferences: { location: [], attributes: [] },
        },
      },
    },
    headers: {
      Accept: '*/*',
      Origin: 'https://www.madlan.co.il',
      Referer: 'https://www.madlan.co.il/for-rent/',
    },
  });
  return readBulletins(body);
}

/**
 * Reads the bulletins out of a GraphQL reply.
 *
 * GraphQL answers errors with HTTP 200, so a failure here looks exactly like
 * an empty city unless the envelope is inspected - the silent-empty-result
 * trap this codebase has hit before. An `errors` array is raised rather than
 * returned as "nothing found".
 */
function readBulletins(body: string): MadlanBulletin[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('madlan returned a body that is not JSON');
  }

  const source = payload as {
    errors?: Array<{ message?: unknown }>;
    data?: { searchBulletinWithUserPreferences?: { bulletins?: unknown } };
  };

  if (Array.isArray(source.errors) && source.errors.length > 0) {
    const first = source.errors[0]?.message;
    throw new Error(`madlan graphql error: ${typeof first === 'string' ? first : 'unknown'}`);
  }

  const bulletins = source.data?.searchBulletinWithUserPreferences?.bulletins;
  return Array.isArray(bulletins) ? (bulletins as MadlanBulletin[]) : [];
}
