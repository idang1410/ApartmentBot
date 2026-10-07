import { listingCityMatches } from '../../core/cities.js';
import type { CityEntry, DeepStep, Listing, SavedSearch, SourceAdapter } from '../../core/types.js';
import { logger } from '../../logger.js';
import { fetchText } from '../../util/http.js';
import { parseOnmapListings } from './onmapNormalize.js';

const API = 'https://phoenix.onmap.co.il/v1/properties/mixed_search';
const PAGE_SIZE = 100;
/** Pages one deep-search step reads, through `$skip`. */
const DEEP_PAGES_PER_STEP = 5;
/** The deep search's last page: 10,000 listings. */
const DEEP_MAX_PAGES = 100;

/**
 * OnMap's public backend, which needs no authentication.
 *
 * Its city filter is geographic rather than a name match: the value is a slug
 * and the server resolves it to a polygon, so listings just outside a city's
 * label but inside its boundary are included. Results are still checked
 * against the city name locally.
 *
 * The slugs are OnMap's own transliterations and do not match anyone else's
 * ("rishon-letsiyon" here, "rishon-le-tsiyon" on Realta), so each is recorded
 * in the city table rather than derived.
 */
export const onmapAdapter: SourceAdapter = {
  name: 'onmap',
  cadenceMinutes: 0,

  supports(_search: SavedSearch, city: CityEntry): boolean {
    return Boolean(city.onmapSlug);
  },

  async fetchListings(search: SavedSearch, city: CityEntry): Promise<Listing[]> {
    if (!city.onmapSlug) return [];

    const listings = (await readPage(city.onmapSlug, city.name, 0)).filter((l) =>
      listingCityMatches(city, l.city),
    );

    logger.debug({ search: search.id, city: city.key, found: listings.length }, 'onmap fetch done');
    return listings;
  },

  async deepSearch(city: CityEntry, from: number): Promise<DeepStep> {
    const collected: Listing[] = [];
    let page = from;
    let ended = !city.onmapSlug;
    while (!ended && page < from + DEEP_PAGES_PER_STEP) {
      const listings = await readPage(city.onmapSlug!, city.name, page);
      page++;
      collected.push(...listings.filter((l) => listingCityMatches(city, l.city)));
      ended = listings.length < PAGE_SIZE || page >= DEEP_MAX_PAGES;
    }
    return { listings: collected, next: ended ? null : page };
  },
};

/** One page of a city, most recently updated first; empty when the body is not JSON. */
async function readPage(slug: string, cityName: string, page: number): Promise<Listing[]> {
  const url =
    `${API}?option=rent,rent-short&section=residence&country=Israel` +
    `&city=${encodeURIComponent(slug)}&$limit=${PAGE_SIZE}&$skip=${page * PAGE_SIZE}&$sort=-search_date`;

  const body = await fetchText(url, {
    source: 'onmap',
    profile: 'desktop',
    headers: {
      Accept: 'application/json',
      Origin: 'https://www.onmap.co.il',
      Referer: 'https://www.onmap.co.il/',
    },
  });

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    logger.warn({ url }, 'onmap returned a non-JSON body');
    return [];
  }
  return parseOnmapListings(payload, cityName);
}
