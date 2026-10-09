import { z } from 'zod';
import type { Listing } from '../../core/types.js';

const BASE = 'https://realta.co.il';

/**
 * Only the fields the bot uses are declared; Realta sends many more
 * (translations, tax estimates) and unknown keys are ignored.
 */
const propertySchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  cityNameHe: z.string().nullish(),
  city: z.string().nullish(),
  districtNameHe: z.string().nullish(),
  streetHe: z.string().nullish(),
  street: z.string().nullish(),
  price: z.number().nullish(),
  rooms: z.number().nullish(),
  sqm: z.number().nullish(),
  lat: z.number().nullish(),
  lon: z.number().nullish(),
  floor: z.number().nullish(),
  floorsTotal: z.number().nullish(),
  images: z.array(z.string()).nullish(),
  amenities: z.array(z.string()).nullish(),
  propertyType: z.string().nullish(),
  source: z.string().nullish(),
  publishedAt: z.string().nullish(),
  url: z.string().nullish(),
  priceIsEstimate: z.boolean().nullish(),
});

export const realtaResponseSchema = z.object({
  properties: z.array(z.unknown()).default([]),
  total: z.number().optional(),
});

/** Realta's amenity codes, rendered the way Israeli listings word them. */
const AMENITY_LABELS: Record<string, string> = {
  PARKING: 'חניה',
  ELEVATOR: 'מעלית',
  BALCONY: 'מרפסת',
  SAFE_ROOM: 'ממ״ד',
  STORAGE: 'מחסן',
  AC: 'מיזוג',
  FURNISHED: 'מרוהטת',
  RENOVATED: 'משופצת',
  PETS_ALLOWED: 'חיות מחמד',
  ACCESSIBLE: 'נגישות',
  BOILER: 'דוד שמש',
  BARS: 'סורגים',
  FIBER: 'סיבים אופטיים',
  KOSHER_KITCHEN: 'מטבח כשר',
  SUKKAH_BALCONY: 'מרפסת סוכה',
};

/**
 * An unmapped code would otherwise be shown to the reader as raw
 * SCREAMING_SNAKE. Turning it into words keeps a newly added amenity
 * presentable until it gets a proper Hebrew label.
 */
function amenityLabel(code: string): string {
  return AMENITY_LABELS[code] ?? code.toLowerCase().replace(/_/g, ' ');
}

const PROPERTY_TYPE_LABELS: Record<string, string> = {
  apartment: 'דירה',
  garden_apartment: 'דירת גן',
  penthouse: 'פנטהאוז',
  duplex: 'דופלקס',
  private_house: 'בית פרטי',
  cottage: 'קוטג׳',
  studio: 'סטודיו',
  roommates: 'שותפים',
  basement: 'מרתף',
  unit: 'יחידת דיור',
  housing_unit: 'יחידת דיור',
};

/**
 * Realta aggregates several boards, so `source` tells us which one a listing
 * actually came from - worth surfacing, because a Facebook post and a Yad2 ad
 * mean different things to someone hunting for a no-broker flat.
 */
const SOURCE_LABELS: Record<string, string> = {
  Yad2: 'יד2',
  Madlan: 'מדלן',
  Komo: 'קומו',
  Homeless: 'הומלס',
  OnMap: 'OnMap',
  FacebookGroup: 'קבוצת פייסבוק',
  FacebookMarketplace: 'פייסבוק מרקטפלייס',
};

/** Sources that are estate agencies rather than private sellers. */
const BROKER_SOURCES = new Set(['Komo']);

export function parseRealtaListings(payload: unknown, fallbackCity: string): Listing[] {
  const outer = realtaResponseSchema.safeParse(payload);
  if (!outer.success) return [];

  const listings: Listing[] = [];
  for (const raw of outer.data.properties) {
    const parsed = propertySchema.safeParse(raw);
    // One malformed entry must not discard the rest of the page.
    if (!parsed.success) continue;

    const p = parsed.data;
    const city = p.cityNameHe ?? p.city ?? fallbackCity;
    const street = p.streetHe ?? p.street ?? null;
    const source = p.source ?? undefined;

    listings.push({
      source: 'realta',
      sourceId: p.id,
      url: p.url ? `${BASE}/he${p.url}` : `${BASE}/he/`,
      // An estimated price is Realta's guess, not the advertised rent.
      price: p.price && !p.priceIsEstimate ? Math.round(p.price) : (p.price ?? null),
      rooms: p.rooms ?? null,
      city,
      ...(p.districtNameHe ? { neighborhood: p.districtNameHe } : {}),
      ...(street ? { address: street } : {}),
      ...(typeof p.lat === 'number' && typeof p.lon === 'number' ? { lat: p.lat, lng: p.lon } : {}),
      ...(p.propertyType
        ? { propertyType: PROPERTY_TYPE_LABELS[p.propertyType] ?? p.propertyType }
        : {}),
      ...(p.sqm ? { sqm: p.sqm } : {}),
      ...(p.floor !== null && p.floor !== undefined
        ? { floor: p.floor === 0 ? 'קומת קרקע' : `קומה ${p.floor}` }
        : {}),
      ...(p.floorsTotal ? { floorsTotal: p.floorsTotal } : {}),
      amenities: (p.amenities ?? []).map(amenityLabel),
      imageUrls: (p.images ?? []).filter((u) => /^https:\/\//.test(u)).slice(0, 4),
      ...(p.publishedAt && !Number.isNaN(Date.parse(p.publishedAt))
        ? { postedAt: new Date(p.publishedAt) }
        : {}),
      ...(source ? { originalSource: SOURCE_LABELS[source] ?? source } : {}),
      ...(source ? { isBroker: BROKER_SOURCES.has(source) } : {}),
    });
  }

  return listings;
}
