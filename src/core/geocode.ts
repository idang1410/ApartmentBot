import type { Db } from '../db/database.js';
import { logger } from '../logger.js';
import { normalizeCityName } from './cities.js';
import type { Listing } from './types.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/** Nominatim's usage policy: an identifying User-Agent and at most one request a second. */
const USER_AGENT = 'ApartmentBot/1.0 (personal rental-listings map)';
const MIN_GAP_MS = 1_100;

export interface Point {
  lat: number;
  lng: number;
}

/**
 * What to ask Nominatim for a listing: its street address, or its
 * neighbourhood when it has no street. A neighbourhood point is approximate.
 * Null when there is neither.
 */
export function geocodeQuery(
  listing: Pick<Listing, 'address' | 'neighborhood' | 'city'>,
): { place: string; city: string; approximate: boolean } | null {
  const place = listing.address?.trim() || listing.neighborhood?.trim();
  if (!place || !listing.city.trim()) return null;
  return { place, city: listing.city.trim(), approximate: !listing.address?.trim() };
}

/** Cache key: normalized "place|city", house number kept. */
export function geocodeKey(place: string, city: string): string {
  return `${normalizeCityName(place)}|${normalizeCityName(city)}`;
}

/**
 * Looks places up on Nominatim, one request at a time, and caches every
 * answer in SQLite for good, misses included.
 */
export class Geocoder {
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private readonly inFlight = new Map<string, Promise<Point | null>>();

  constructor(
    private readonly db: Db,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** The cached answer: a point, null for a known miss, undefined when never asked. */
  cached(place: string, city: string): Point | null | undefined {
    const row = this.db
      .prepare('SELECT lat, lng FROM geocode_cache WHERE key = ?')
      .get(geocodeKey(place, city)) as { lat: number | null; lng: number | null } | undefined;
    if (!row) return undefined;
    return row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null;
  }

  /** Resolves a place, from the cache or from Nominatim. */
  locate(place: string, city: string): Promise<Point | null> {
    const hit = this.cached(place, city);
    if (hit !== undefined) return Promise.resolve(hit);

    const key = geocodeKey(place, city);
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const job = this.queue
      .then(() => this.request(place, city, key))
      .finally(() => this.inFlight.delete(key));
    this.queue = job.catch(() => undefined);
    this.inFlight.set(key, job);
    return job;
  }

  private async request(place: string, city: string, key: string): Promise<Point | null> {
    const wait = this.lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();

    const url = new URL(NOMINATIM);
    url.searchParams.set('q', `${place}, ${city}`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('countrycodes', 'il');
    url.searchParams.set('limit', '1');

    const response = await this.fetchFn(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'he' },
    });
    // A server error is not a miss, so it is not cached.
    if (!response.ok) throw new Error(`nominatim answered ${response.status}`);

    const results = (await response.json()) as Array<{ lat?: string; lon?: string }>;
    const lat = Number(results[0]?.lat);
    const lng = Number(results[0]?.lon);
    const point = Number.isFinite(lat) && Number.isFinite(lng) && results[0] ? { lat, lng } : null;

    this.db
      .prepare('INSERT OR REPLACE INTO geocode_cache (key, lat, lng) VALUES (?, ?, ?)')
      .run(key, point?.lat ?? null, point?.lng ?? null);
    logger.debug({ key, found: point !== null }, 'geocoded');
    return point;
  }
}
