import { z } from 'zod';
import type { Listing } from '../../core/types.js';
import { plausiblePrice } from '../generic/genericAdapter.js';

/**
 * OnMap nests its measurements instead of publishing plain numbers:
 *
 *   "area":  { "base": 78, "garden": null, "field": null }
 *   "floor": { "on_the": 1, "out_of": 4 }
 *
 * An earlier schema expected `number` for both, so every single row failed
 * validation and the adapter returned an empty list for every city - silently,
 * because a failed row is skipped rather than logged. Accepting either shape
 * fixes that and survives a future flattening of the API.
 */
const areaSchema = z
  .union([z.number(), z.object({ base: z.number().nullish() }).transform((a) => a.base ?? null)])
  .nullish();

const floorSchema = z
  .union([
    z.number().transform((n) => ({ on_the: n, out_of: null })),
    z.object({ on_the: z.number().nullish(), out_of: z.number().nullish() }),
  ])
  .nullish();

const propertySchema = z.object({
  _id: z.string().optional(),
  id: z.union([z.string(), z.number()]).optional(),
  slug: z.string().nullish(),
  price: z.number().nullish(),
  property_type: z.string().nullish(),
  address: z
    .object({
      he: z
        .object({
          city_name: z.string().nullish(),
          neighborhood: z.string().nullish(),
          street_name: z.string().nullish(),
          house_number: z.union([z.string(), z.number()]).nullish(),
        })
        .nullish(),
      location: z.object({ lat: z.number(), lon: z.number() }).nullish(),
    })
    .nullish(),
  additional_info: z
    .object({
      rooms: z.number().nullish(),
      floor: floorSchema,
      area: areaSchema,
    })
    .nullish(),
  advertiser_type: z.string().nullish(),
  images: z.array(z.union([z.string(), z.object({ url: z.string().nullish() })])).nullish(),
  created_at: z.string().nullish(),
  search_date: z.string().nullish(),
});

function positive(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined;
}

function parseDate(...candidates: (string | null | undefined)[]): Date | undefined {
  for (const raw of candidates) {
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return new Date(ms);
  }
  return undefined;
}

/**
 * Turns an OnMap `mixed_search` payload into listings.
 *
 * `cityName` only labels rows whose address omits a city; the caller still
 * filters by city, matching how the other normalizers work.
 */
export function parseOnmapListings(payload: unknown, cityName: string): Listing[] {
  const rows = Array.isArray(payload)
    ? payload
    : ((payload as { data?: unknown[] } | null)?.data ?? []);
  if (!Array.isArray(rows)) return [];

  const listings: Listing[] = [];
  for (const raw of rows) {
    const parsed = propertySchema.safeParse(raw);
    if (!parsed.success) continue;

    const p = parsed.data;
    const id = p._id ?? (p.id !== undefined ? String(p.id) : null);
    if (!id) continue;

    const he = p.address?.he;
    const street = he?.street_name ?? null;
    const house = he?.house_number ?? null;
    const rooms = positive(p.additional_info?.rooms) ?? null;
    const floor = p.additional_info?.floor;
    const onThe = floor?.on_the;
    const sqm = positive(p.additional_info?.area ?? null);
    const postedAt = parseDate(p.created_at, p.search_date);

    listings.push({
      source: 'onmap',
      sourceId: id,
      url: p.slug ? `https://www.onmap.co.il/property/${p.slug}` : 'https://www.onmap.co.il/',
      // The query asks for rent-short too, which prices some rows per night
      // (480 ₪ for a 3-room flat). plausiblePrice drops those.
      price: plausiblePrice(
        typeof p.price === 'number' && p.price > 0 ? Math.round(p.price) : null,
        rooms,
      ),
      rooms,
      city: he?.city_name ?? cityName,
      ...(he?.neighborhood ? { neighborhood: he.neighborhood } : {}),
      ...(street ? { address: `${street}${house ? ` ${house}` : ''}` } : {}),
      ...(p.address?.location ? { lat: p.address.location.lat, lng: p.address.location.lon } : {}),
      ...(p.property_type ? { propertyType: p.property_type } : {}),
      ...(sqm ? { sqm } : {}),
      ...(typeof onThe === 'number'
        ? { floor: onThe === 0 ? 'קומת קרקע' : `קומה ${onThe}` }
        : {}),
      ...(positive(floor?.out_of) ? { floorsTotal: floor!.out_of as number } : {}),
      amenities: [],
      imageUrls: (p.images ?? [])
        .map((i) => (typeof i === 'string' ? i : i?.url))
        .filter((u): u is string => typeof u === 'string' && u.startsWith('https://'))
        .slice(0, 1),
      ...(postedAt ? { postedAt } : {}),
      originalSource: 'OnMap',
      ...(p.advertiser_type ? { isBroker: !/private|owner|בעל/i.test(p.advertiser_type) } : {}),
    });
  }

  return listings;
}
