import { listingCityMatches } from '../../core/cities.js';
import type { CityEntry, Listing } from '../../core/types.js';

/** One row of `searchBulletinWithUserPreferences`, as far as we read it. */
export interface MadlanBulletin {
  id?: unknown;
  price?: unknown;
  beds?: unknown;
  area?: unknown;
  floor?: unknown;
  dealType?: unknown;
  lastUpdated?: unknown;
  sellerType?: unknown;
  description?: unknown;
  addressDetails?: {
    city?: unknown;
    neighbourhood?: unknown;
    streetName?: unknown;
    streetNumber?: unknown;
  } | null;
  locationPoint?: { lat?: unknown; lng?: unknown } | null;
  amenities?: { secureRoom?: unknown; miklat?: unknown; mamak?: unknown } | null;
}

/**
 * Madlan returns sales and rentals from the same query, distinguished only by
 * this. A bulletin whose type we do not recognise is dropped rather than
 * guessed - a ₪6,000,000 flat arriving as a rental would clear every price
 * filter the bot has, since those only reject listings that are too expensive
 * at the top end and this one is off the scale entirely.
 */
const RENT = 'unitRent';

/**
 * Turns one page of bulletins into listings for a city.
 *
 * The API has no city filter - the field names for its `location` predicates
 * are private and every candidate was rejected - so the adapter asks for the
 * newest listings nationwide and the city is matched here instead. That is
 * why this takes a `CityEntry` and not a city name: matching goes through
 * `listingCityMatches`, so a listing that says "פתח תקוה" still belongs to
 * "פתח תקווה".
 */
export function normalizeMadlanBulletins(
  bulletins: readonly MadlanBulletin[],
  city: CityEntry,
): Listing[] {
  const listings: Listing[] = [];

  for (const bulletin of bulletins) {
    if (bulletin.dealType !== RENT) continue;

    const id = text(bulletin.id);
    const listingCity = text(bulletin.addressDetails?.city);
    if (!id || !listingCity || !listingCityMatches(city, listingCity)) continue;

    const street = text(bulletin.addressDetails?.streetName);
    const number = text(bulletin.addressDetails?.streetNumber);
    const address = street ? [street, number].filter(Boolean).join(' ') : undefined;

    listings.push({
      source: 'madlan',
      sourceId: id,
      // `url` comes back empty on every row; the page is addressed by id.
      url: `https://www.madlan.co.il/listings/${encodeURIComponent(id)}`,
      price: number_(bulletin.price),
      rooms: number_(bulletin.beds),
      city: listingCity,
      amenities: [
        ...(bulletin.amenities?.secureRoom === true ? ['ממ״ד'] : []),
        ...(bulletin.amenities?.miklat === true || bulletin.amenities?.mamak === true ? ['מקלט'] : []),
      ],
      imageUrls: [],
      ...(address ? { address } : {}),
      ...(typeof bulletin.locationPoint?.lat === 'number' &&
      typeof bulletin.locationPoint?.lng === 'number'
        ? { lat: bulletin.locationPoint.lat, lng: bulletin.locationPoint.lng }
        : {}),
      ...(text(bulletin.addressDetails?.neighbourhood)
        ? { neighborhood: text(bulletin.addressDetails?.neighbourhood)! }
        : {}),
      ...(number_(bulletin.area) !== null ? { sqm: number_(bulletin.area)! } : {}),
      ...(text(bulletin.floor) ? { floor: text(bulletin.floor)! } : {}),
      ...(text(bulletin.description) ? { description: text(bulletin.description)! } : {}),
      ...(postedAt(bulletin.lastUpdated) ? { postedAt: postedAt(bulletin.lastUpdated)! } : {}),
      // "agent" and "private" are Madlan's own words, and the only two values
      // seen. Anything else leaves the flag unset rather than guessing, which
      // is what a "private only" search needs: unknown must not read as broker.
      ...(bulletin.sellerType === 'agent'
        ? { isBroker: true }
        : bulletin.sellerType === 'private'
          ? { isBroker: false }
          : {}),
    });
  }

  return listings;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Zero rooms or zero price means "not published", the same as absent. */
function number_(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function postedAt(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
