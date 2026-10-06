import { z } from 'zod';
// cities.ts imports only types from here, so this direction carries no cycle
// at runtime. The fingerprint needs the same place normalisation the area
// filter uses, or "נהר הירדן 24" and "נהר הירדן" stay different streets.
import { normalizeCityName, normalizePlace } from './cities.js';
import type { TrackStatus } from './tracking.js';

/** A rental listing after a source adapter has normalized it. */
export const listingSchema = z.object({
  source: z.string(),
  /** Stable id within the source. Combined with `source` this is the dedupe key. */
  sourceId: z.string().min(1),
  url: z.string().url(),
  /** Monthly rent in NIS. null when the source did not publish a price. */
  price: z.number().int().positive().nullable(),
  rooms: z.number().positive().nullable(),
  city: z.string(),
  neighborhood: z.string().optional(),
  address: z.string().optional(),
  /** WGS84 position, when the source publishes one. */
  lat: z.number().optional(),
  lng: z.number().optional(),
  propertyType: z.string().optional(),
  sqm: z.number().positive().optional(),
  /** Free text, because sources write "קרקע"/"קומה 2"/"פרטר". */
  floor: z.string().optional(),
  /** Building height, so a listing can read "קומה 2 מתוך 6". */
  floorsTotal: z.number().int().positive().optional(),
  /** Hebrew feature labels already translated for display, e.g. "חניה". */
  amenities: z.array(z.string()).default([]),
  /** Free-text ad body, when the source publishes one. */
  description: z.string().optional(),
  imageUrls: z.array(z.string().url()).default([]),
  postedAt: z.date().optional(),
  /** Move-in date, when the ad states one; `entryText` keeps the wording ("מיידי"). */
  entryDate: z.date().optional(),
  entryText: z.string().optional(),
  /** A contact number the ad itself published; only the free-text sources have one. */
  phone: z.string().optional(),
  /** Which underlying board the listing came from, e.g. "Yad2", "Facebook". */
  originalSource: z.string().optional(),
  /** true when posted by an agency. Undefined when the source does not say. */
  isBroker: z.boolean().optional(),
  /**
   * A number the source assigns in creation order, higher is newer (Yad2's ad number). It
   * tells an ad created before a search began from one created after, however recently
   * either was bumped to the top of a feed. Undefined when the source has no such number.
   */
  sequence: z.number().int().positive().optional(),
});

export type Listing = z.infer<typeof listingSchema>;

/**
 * How well a listing fits a search: inside every bound, or just outside a
 * price or room bound - close enough to be worth a look, flagged as such.
 */
export type MatchKind = 'exact' | 'near';

/**
 * What a listing must have beyond city, rooms and price. Every field is
 * optional; an unknown value on the listing never counts against it, in the
 * same spirit as the room filter (price is the one field that must be known).
 */
export interface SearchRequirements {
  /** Must-have amenities from the fixed Hebrew vocabulary, e.g. "חניה". */
  amenities?: string[];
  brokers?: 'any' | 'private-only';
  minSqm?: number;
  propertyTypes?: string[];
  /** Words that must all appear somewhere in the ad. */
  keywords?: string[];
}

/** A search the owner saved through the /add wizard. */
export interface SavedSearch {
  id: number;
  /** Telegram chat that owns this search; its alerts go back here. */
  chatId: number;
  name: string;
  /** Every city this search covers; at least one. */
  cityKeys: string[];
  cityName: string;
  /**
   * Streets and neighbourhoods to restrict each city to, keyed by city key.
   *
   * A city that is absent, or maps to an empty list, is searched whole. Both
   * kinds of place live in one list because a listing is matched the same way
   * either way: against its neighbourhood and against its street.
   */
  areas?: Record<string, string[]>;
  minRooms: number | null;
  maxRooms: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  /** Absent means no requirements beyond the bounds above. */
  requirements?: SearchRequirements;
  active: boolean;
  createdAt: string;
}

/**
 * A city the bot can watch. Homeless and Madlan URLs are derived from `name`
 * (verified against both sites), so only Yad2 needs a lookup code.
 */
export interface CityEntry {
  /** Normalized name; stable key stored on saved searches. */
  key: string;
  /** Canonical Hebrew name, used to build source URLs. */
  name: string;
  /** Other spellings that mean this city, e.g. hyphenated forms. */
  aliases: string[];
  /** Homeless region id, which returns nearby towns as well as the city. */
  homelessRegionCode?: string;
  /** Realta city slug; without it the aggregator cannot be queried. */
  realtaSlug?: string;
  /** OnMap city slug - resolved server-side to a geographic polygon. */
  onmapSlug?: string;
  /** Yad2 city code. */
  yad2CityCode?: number;
  /** Yad2 region id - mandatory on its API; requests without it are rejected. */
  yad2RegionCode?: number;
}

/** How a fetch will be used. */
export interface FetchOptions {
  /**
   * True for /latest previews and new-search seeding. A source that remembers what it has
   * read (Yad2's page walk) may use that memory but must not add to it: only a poll cycle
   * hands listings to the alert path, so only a poll cycle may mark them as read.
   */
  preview?: boolean;
}

export interface SourceAdapter {
  readonly name: string;
  /**
   * Minimum wall-clock minutes between fetches. 0 = every cycle.
   *
   * Minutes rather than cycles, so that shortening POLL_MINUTES makes the
   * cheap sources faster without also making the slow, risky ones run more
   * often than they should.
   */
  readonly cadenceMinutes: number;
  /**
   * When true, failures are logged but never reported to the owner.
   *
   * For sources expected to be unavailable much of the time, where the point
   * is to fold them back in automatically if they recover - a daily "still
   * blocked" message would be noise, not news.
   */
  readonly bestEffort?: boolean;
  /** False when this source has no location mapping for the search's city. */
  supports(search: SavedSearch, city: CityEntry): boolean;
  fetchListings(search: SavedSearch, city: CityEntry, options?: FetchOptions): Promise<Listing[]>;
}

/**
 * Identifies one physical apartment independently of which board listed it.
 *
 * Aggregators re-publish the boards, so the same flat arrives under different
 * ids from different sources - dorin.app reports an 88% cross-source duplicate
 * rate.
 *
 * A size or a street address is required on top of price and rooms. City,
 * rooms and price alone are not distinctive enough: two different 3-room flats
 * at 6,000 ₪ in one city are perfectly ordinary, and merging them would
 * silently drop a real listing - a worse failure than a duplicate alert.
 *
 * Returns null when the listing is too vague to fingerprint safely, in which
 * case it is deduped by source id alone.
 *
 * The street wins over the size when both are known, and the house number is
 * dropped. Choosing per listing - size when known, street otherwise - meant
 * two boards carrying one flat produced different keys whenever they
 * disagreed about the size or only one of them published it, which is exactly
 * the pair the fingerprint exists to collapse. yad2 listed נהר הירדן 24 at
 * 170 m² and realta the same flat as נהר הירדן with no size; both were sent.
 *
 * Dropping the house number is what makes a street comparable at all, since
 * boards include it inconsistently, and it is the one loosening here: two
 * different flats on one street at the same price with the same room count
 * now merge. Measured over three weeks of real data that rule collapsed 34
 * groups, of which 5 had sizes more than 15% apart - so at most a handful of
 * genuine listings are traded for 29 duplicates removed.
 */
export function listingFingerprint(listing: Listing): string | null {
  if (listing.price === null || listing.rooms === null) return null;
  if (listing.sqm === undefined && !listing.address) return null;

  const discriminator = listing.address
    ? `a${normalizePlace(listing.address)}`
    : `m${listing.sqm}`;
  return `${normalizeCityName(listing.city)}|${listing.rooms}|${listing.price}|${discriminator}`;
}

/** Sizes within this many m² count as one flat; boards round and measure differently. */
const SQM_TOLERANCE = 5;

/**
 * Whether two listings are one flat, ignoring price. Both need a street, and
 * city, street and rooms must agree. Sizes, when both are known, must be close;
 * house numbers, when both are known, must be equal. A street with no number
 * matches a numbered one only when both sizes are known and close. Two known,
 * different floors make it 'maybe'.
 */
export function sameFlat(a: Listing, b: Listing): 'same' | 'maybe' | null {
  if (!a.address || !b.address || a.rooms === null || a.rooms !== b.rooms) return null;
  if (normalizeCityName(a.city) !== normalizeCityName(b.city)) return null;
  const street = normalizePlace(a.address);
  if (!street || street !== normalizePlace(b.address)) return null;

  const bothSqm = a.sqm !== undefined && b.sqm !== undefined;
  if (bothSqm && Math.abs(a.sqm! - b.sqm!) > SQM_TOLERANCE) return null;
  const numA = houseNumber(a.address);
  const numB = houseNumber(b.address);
  if (numA && numB && numA !== numB) return null;
  if ((numA === null) !== (numB === null) && !bothSqm) return null;

  const floorA = a.floor ? floorKey(a.floor) : null;
  const floorB = b.floor ? floorKey(b.floor) : null;
  return floorA !== null && floorB !== null && floorA !== floorB ? 'maybe' : 'same';
}

/** Another stored listing of the same flat, with the status the owner set on it. */
export interface ListingCopy {
  listing: Listing;
  kind: 'same' | 'maybe';
  status: TrackStatus | null;
}

function houseNumber(address: string): string | null {
  return /\s(\d+[א-ת]?)\s*$/u.exec(address)?.[1] ?? null;
}

/** "קומה 3", "קומה:3 מתוך 3" and "3" are one floor; "קרקע" is 0. */
function floorKey(floor: string): string {
  if (floor.includes('קרקע')) return '0';
  return /\d+/.exec(floor)?.[0] ?? floor.trim();
}

/**
 * Lets a source recognise a listing the bot has already recorded, so it can
 * hand back the stored copy instead of doing the work - a model call, for the
 * free-text sources - of reading it again.
 */
export interface StoredListings {
  find(source: string, sourceId: string): Listing | undefined;
}

/**
 * Thrown when a source needs a login the owner must renew by hand. Unlike an
 * ordinary failure it cannot fix itself, so the owner is told at once, with
 * the command to run, and the source waits instead of retrying.
 */
export class SessionExpiredError extends Error {
  constructor(
    readonly source: string,
    readonly instruction: string,
  ) {
    super(`${source} session expired - run ${instruction} to sign in again`);
    this.name = 'SessionExpiredError';
  }
}

/**
 * Thrown when a source answers with a bot-challenge page instead of content.
 * Callers back off harder for this than for an ordinary failure, because
 * retrying quickly makes a block worse.
 */
export class BlockedError extends Error {
  constructor(source: string, detail: string) {
    super(`${source} served a bot-protection page: ${detail}`);
    this.name = 'BlockedError';
  }
}
