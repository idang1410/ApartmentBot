import type { Listing, MatchKind, SavedSearch, SearchRequirements } from './types.js';
import { expandArea, findCityByKey, listingCityMatches, normalizePlace } from './cities.js';
import { daysBetween } from '../util/time.js';

/**
 * Decides whether a listing belongs in a search's alerts.
 *
 * Sources are asked for a whole city rather than a filtered feed (Yad2's
 * robots.txt disallows price-filtered URLs, and the others filter
 * inconsistently), so this is where the owner's bounds are actually applied.
 */
/**
 * Only listings posted within this many days are worth alerting on. Anything
 * older has almost always been let.
 *
 * This is the owner's headline requirement, and it is enforced two ways
 * because most sources publish no date at all:
 *  - where a date exists (Realta, OnMap), it is applied directly here;
 *  - where it does not, `PollCycle` seeds a source's whole back catalogue
 *    silently on first sight, so only listings that appear afterwards - and
 *    are therefore newly posted - ever reach an alert.
 */
export const MAX_LISTING_AGE_DAYS = 30;

export function matchesSearch(listing: Listing, search: SavedSearch): boolean {
  return (
    isFreshEnough(listing) &&
    withinPrice(listing, search) &&
    withinRooms(listing, search) &&
    withinAreas(listing, search) &&
    meetsRequirements(listing, search.requirements) === 'exact'
  );
}

/**
 * The amenity labels every source is normalised to, and the model prompts
 * are constrained to. The wizard offers exactly these.
 */
export const AMENITY_VOCABULARY = [
  'חניה', 'מעלית', 'מרפסת', 'ממ״ד', 'מחסן', 'מיזוג', 'מרוהטת', 'משופצת', 'חיות מחמד', 'גינה', 'מקלט',
] as const;

/** Requirements a better amenity also meets: a ממ״ד in the flat is at least a shelter in the building. */
const SATISFIED_BY: Record<string, string[]> = {
  [normalizeLabel('מקלט')]: [normalizeLabel('ממ״ד')],
};

/** Quote marks vary between sources (ממ"ד, ממ״ד); labels compare without them. */
function normalizeLabel(text: string): string {
  return text.replace(/["'״׳`]/g, '').replace(/\s+/g, ' ').trim();
}

/** The required amenities the listing does not list. */
export function missingAmenities(listing: Listing, required: string[] | undefined): string[] {
  if (!required || required.length === 0) return [];
  const have = new Set(listing.amenities.map(normalizeLabel));
  return required.filter((amenity) => {
    const label = normalizeLabel(amenity);
    return !have.has(label) && !(SATISFIED_BY[label] ?? []).some((better) => have.has(better));
  });
}

/**
 * Whether a listing satisfies the search's requirements beyond its bounds.
 *
 * Exactly one missing amenity is a near miss - dorin's "flexible filtering",
 * and the difference between "no parking" and "did not mention parking". A
 * listing that does not publish a size, type or broker status is not held
 * against it, for the same reason unknown room counts pass.
 */
export function meetsRequirements(
  listing: Listing,
  requirements: SearchRequirements | undefined,
): MatchKind | null {
  if (!requirements) return 'exact';

  if (requirements.brokers === 'private-only' && listing.isBroker === true) return null;

  if (
    requirements.minSqm !== undefined &&
    listing.sqm !== undefined &&
    listing.sqm < requirements.minSqm
  ) {
    return null;
  }

  const types = requirements.propertyTypes?.map(normalizeLabel) ?? [];
  if (types.length > 0 && listing.propertyType && !types.includes(normalizeLabel(listing.propertyType))) {
    return null;
  }

  const keywords = requirements.keywords ?? [];
  if (keywords.length > 0) {
    const haystack = normalizeLabel(
      [listing.description, listing.address, listing.neighborhood, listing.propertyType, ...listing.amenities]
        .filter((value): value is string => Boolean(value))
        .join(' '),
    );
    if (!keywords.every((keyword) => haystack.includes(normalizeLabel(keyword)))) return null;
  }

  const missing = missingAmenities(listing, requirements.amenities);
  if (missing.length > 1) return null;
  return missing.length === 1 ? 'near' : 'exact';
}

/**
 * Restricts a city to chosen streets and neighbourhoods.
 *
 * A city with nothing chosen is searched whole, so this is invisible unless
 * the owner asked for it. When areas *are* chosen, a listing that publishes
 * neither street nor neighbourhood is dropped: asking for two streets and
 * being sent an address-less ad is not what "only these streets" means.
 * About 6% of listings are affected, which is the cost of the precision.
 */
export function withinAreas(listing: Listing, search: SavedSearch): boolean {
  const areas = search.areas;
  if (!areas) return true;

  // Which of the search's cities is this listing in? Only that city's areas
  // apply - picking streets in Modi'in must not filter Rishon listings.
  const cityKey = search.cityKeys.find((key) => {
    const city = findCityByKey(key);
    return city !== undefined && listingCityMatches(city, listing.city);
  });

  const wanted = cityKey ? areas[cityKey] : undefined;
  if (!wanted || wanted.length === 0) return true;

  const candidates = [listing.neighborhood, listing.address]
    .filter((value): value is string => Boolean(value))
    .map(normalizePlace);
  if (candidates.length === 0) return false;

  // A region alias stands for several neighbourhoods; a street is itself.
  const targets = wanted.flatMap((area) => expandArea(cityKey!, area));

  return targets.some((area) => {
    const target = normalizePlace(area);
    if (!target) return false;
    // Substring either way: a listing may say "משואה (גבעת C)" for the area
    // "משואה", and a picked street may be the fuller name of a shorter one.
    return candidates.some((c) => c === target || c.includes(target) || target.includes(c));
  });
}

/**
 * Rejects listings known to be old.
 *
 * A listing whose date is unknown is kept, because most boards publish none
 * and dropping them would silence the bot entirely. First-sight seeding is
 * what stops those undated sources from alerting stale inventory.
 */
export function isFreshEnough(listing: Listing, now: Date = new Date()): boolean {
  if (!listing.postedAt) return true;
  return daysBetween(listing.postedAt, now) <= MAX_LISTING_AGE_DAYS;
}

/**
 * A listing with no published price is dropped, whether or not the search
 * has a price bound. This is the one strict exception to the permissive
 * filters: on Yad2 "מחיר לא צוין" is almost always a broker withholding the
 * figure to force a call, and the owner asked not to see those at all
 * (2026-09-14). An ad that later gains a price is fetched afresh and alerts
 * then, because a dropped listing is never recorded as seen.
 */
function withinPrice(listing: Listing, search: SavedSearch): boolean {
  if (listing.price === null) return false;
  if (search.minPrice !== null && listing.price < search.minPrice) return false;
  if (search.maxPrice !== null && listing.price > search.maxPrice) return false;
  return true;
}

/**
 * Unknown room counts are shown, not hidden. Unlike price, a missing room
 * count is a parsing gap far more often than a seller's choice.
 */
function withinRooms(listing: Listing, search: SavedSearch): boolean {
  if (listing.rooms === null) return true;
  if (search.minRooms !== null && listing.rooms < search.minRooms) return false;
  if (search.maxRooms !== null && listing.rooms > search.maxRooms) return false;
  return true;
}

/**
 * How far outside a bound a listing may fall and still be worth a look.
 *
 * A ₪5,000 floor hid a ₪4,950 flat the owner would have wanted to see. Bounds
 * are guesses about the market; a near miss is sent flagged rather than
 * silently dropped, so the guess can be corrected instead of costing a flat.
 */
export const NEAR_PRICE_FRACTION = 0.1;
export const NEAR_ROOMS = 0.5;

type Verdict = 'in' | 'near' | 'out';

function priceVerdict(listing: Listing, search: SavedSearch): Verdict {
  const price = listing.price;
  // No price is no match, not a near miss - see `withinPrice`.
  if (price === null) return 'out';
  if (search.minPrice !== null && price < search.minPrice) {
    return search.minPrice - price <= search.minPrice * NEAR_PRICE_FRACTION ? 'near' : 'out';
  }
  if (search.maxPrice !== null && price > search.maxPrice) {
    return price - search.maxPrice <= search.maxPrice * NEAR_PRICE_FRACTION ? 'near' : 'out';
  }
  return 'in';
}

function roomsVerdict(listing: Listing, search: SavedSearch): Verdict {
  const rooms = listing.rooms;
  if (rooms === null) return 'in';
  if (search.minRooms !== null && rooms < search.minRooms) {
    return search.minRooms - rooms <= NEAR_ROOMS ? 'near' : 'out';
  }
  if (search.maxRooms !== null && rooms > search.maxRooms) {
    return rooms - search.maxRooms <= NEAR_ROOMS ? 'near' : 'out';
  }
  return 'in';
}

/**
 * Like `matchesSearch`, but distinguishes a near miss from no match. Areas
 * and freshness are never relaxed: "only these streets" and "posted this
 * month" are not guesses.
 */
export function classifyMatch(listing: Listing, search: SavedSearch): MatchKind | null {
  if (!isFreshEnough(listing) || !withinAreas(listing, search)) return null;

  const price = priceVerdict(listing, search);
  const rooms = roomsVerdict(listing, search);
  const requirements = meetsRequirements(listing, search.requirements);
  if (price === 'out' || rooms === 'out' || requirements === null) return null;
  return price === 'near' || rooms === 'near' || requirements === 'near' ? 'near' : 'exact';
}

/** Why a near miss is a near miss, in the owner's own terms; null for an exact match. */
export function nearMissReason(listing: Listing, search: SavedSearch): string | null {
  const parts: string[] = [];

  const price = listing.price;
  if (price !== null && priceVerdict(listing, search) === 'near') {
    if (search.minPrice !== null && price < search.minPrice) {
      parts.push(`${format(price)} ₪ - מתחת למינימום ב-${percent(search.minPrice - price, search.minPrice)}%`);
    } else if (search.maxPrice !== null && price > search.maxPrice) {
      parts.push(`${format(price)} ₪ - מעל המקסימום ב-${percent(price - search.maxPrice, search.maxPrice)}%`);
    }
  }

  const rooms = listing.rooms;
  if (rooms !== null && roomsVerdict(listing, search) === 'near') {
    if (search.minRooms !== null && rooms < search.minRooms) {
      parts.push(`${rooms} חד׳ - חצי חדר פחות מהמינימום`);
    } else if (search.maxRooms !== null && rooms > search.maxRooms) {
      parts.push(`${rooms} חד׳ - חצי חדר יותר מהמקסימום`);
    }
  }

  const missing = missingAmenities(listing, search.requirements?.amenities);
  if (missing.length === 1) parts.push(`חסר: ${missing[0]}`);

  return parts.length > 0 ? parts.join(' · ') : null;
}

function percent(difference: number, bound: number): number {
  return Math.round((difference / bound) * 100);
}

export function describeSearch(search: SavedSearch): string {
  const parts: string[] = [search.cityName];

  if (search.minRooms !== null && search.maxRooms !== null) {
    parts.push(`${search.minRooms}–${search.maxRooms} חד׳`);
  } else if (search.minRooms !== null) {
    parts.push(`${search.minRooms}+ חד׳`);
  } else if (search.maxRooms !== null) {
    parts.push(`עד ${search.maxRooms} חד׳`);
  }

  if (search.minPrice !== null && search.maxPrice !== null) {
    parts.push(`${format(search.minPrice)}–${format(search.maxPrice)} ₪`);
  } else if (search.maxPrice !== null) {
    parts.push(`עד ${format(search.maxPrice)} ₪`);
  } else if (search.minPrice !== null) {
    parts.push(`מ-${format(search.minPrice)} ₪`);
  }

  const requirements = search.requirements;
  if (requirements?.amenities?.length) parts.push(requirements.amenities.join(', '));
  if (requirements?.brokers === 'private-only') parts.push('ללא תיווך');
  if (requirements?.minSqm) parts.push(`${requirements.minSqm}+ מ״ר`);
  if (requirements?.propertyTypes?.length) parts.push(requirements.propertyTypes.join('/'));
  if (requirements?.keywords?.length) parts.push(requirements.keywords.map((k) => `"${k}"`).join(' '));

  return parts.join(' · ');
}

function format(value: number): string {
  return value.toLocaleString('en-US');
}
