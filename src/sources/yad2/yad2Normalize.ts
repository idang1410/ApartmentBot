import { z } from 'zod';
import type { Listing } from '../../core/types.js';

const ITEM_BASE = 'https://www.yad2.co.il/realestate/item';

const markerSchema = z.object({
  token: z.string().min(1),
  price: z.number().nullish(),
  adType: z.string().nullish(),
  address: z
    .object({
      city: z.object({ text: z.string().nullish() }).nullish(),
      neighborhood: z.object({ text: z.string().nullish() }).nullish(),
      street: z.object({ text: z.string().nullish() }).nullish(),
      house: z.object({ number: z.number().nullish(), floor: z.number().nullish() }).nullish(),
      coords: z.object({ lat: z.number(), lon: z.number() }).nullish(),
    })
    .nullish(),
  additionalDetails: z
    .object({
      property: z.object({ text: z.string().nullish() }).nullish(),
      roomsCount: z.number().nullish(),
      squareMeter: z.number().nullish(),
    })
    .nullish(),
  metaData: z
    .object({
      coverImage: z.string().nullish(),
      images: z.array(z.string()).nullish(),
    })
    .nullish(),
  tags: z.array(z.object({ name: z.string().nullish() }).passthrough()).nullish(),
});

/**
 * A feed ad: exactly a map marker plus Yad2's ad number. `orderId` is assigned in creation
 * order, so it tells an ad created before a search began from one created after, however
 * recently either was bumped.
 */
const itemSchema = markerSchema.extend({
  orderId: z.number().int().positive().nullish(),
});

type Yad2Item = z.infer<typeof itemSchema>;

/**
 * Feed sections that hold rental ads. The rest are paid placements: `yad1` is new projects
 * for sale, and `trio`, `leadingBroker` and `kingOfTheHar` carry no ad token and photos from
 * as far back as 2010.
 */
const FEED_SECTIONS = ['private', 'agency', 'platinum', 'booster'] as const;

type FeedSection = (typeof FEED_SECTIONS)[number];

const feedSchema = z.object({
  data: z.object({
    private: z.array(z.unknown()),
    agency: z.array(z.unknown()),
    platinum: z.array(z.unknown()).nullish(),
    booster: z.array(z.unknown()).nullish(),
    pagination: z.object({ totalPages: z.number().int().nonnegative().nullish() }).nullish(),
  }),
});

/** One page of a city's rental feed. */
export interface Yad2FeedPage {
  /** Residential listings on the page, every section pooled. */
  listings: Listing[];
  /**
   * Tokens of the page's organic ads (`private`, `agency`), homes or not: what page walking
   * compares. The promoted `platinum`/`booster` slots rotate on every request, so counting
   * them made every page look new and every walk run to MAX_PAGES (measured on Tel Aviv:
   * the same 40 organic ads twice in a row, four different promoted ones each time).
   */
  tokens: string[];
  totalPages: number;
}

/**
 * Yad2's rental feed also carries storage units, parking spaces and business
 * premises. None of them are somewhere to live, so they are dropped rather
 * than alerted on.
 */
const NON_RESIDENTIAL = /מחסן|חניה|חנייה|משרד|חנות|מסחרי|קליניקה|מבנה|מגרש|תעשי/;

/** Israel runs UTC+3 in summer; the stamps are written in local time. */
const ISRAEL_UTC_OFFSET_HOURS = 3;

/**
 * Recovers a posting date from a photo URL.
 *
 * Yad2's API publishes no date field anywhere, but its images live under a
 * path that encodes when they were uploaded, which happens within minutes of
 * the ad going live (checked against Realta's publish times: consistently 3-7
 * minutes apart). It is the only way to apply "posted in the last 30 days" to
 * the largest source.
 *
 * Three shapes, in decreasing precision:
 *   .../y2_1pa_010595_20260816161412.jpeg   second precision
 *   .../y2_1pa_010595_20260816.jpeg         day precision (agency bulk uploads)
 *   .../Pic/202608/16/...                   day precision, from the path itself
 */
export function dateFromImageUrl(url: string | null | undefined): Date | undefined {
  const text = url ?? '';
  if (!text) return undefined;

  const toDate = (iso: string): Date | undefined => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return undefined;
    const year = date.getFullYear();
    return year >= 2015 && date.getTime() <= Date.now() + 86_400_000 ? date : undefined;
  };
  const utc = (parts: string[]) =>
    `${parts[0]}-${parts[1]}-${parts[2]}T${parts[3] ?? '00'}:${parts[4] ?? '00'}:${parts[5] ?? '00'}` +
    `+0${ISRAEL_UTC_OFFSET_HOURS}:00`;

  const second = /_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(?:jpe?g|png|webp)/i.exec(text);
  if (second) return toDate(utc(second.slice(1)));

  const day = /_(\d{4})(\d{2})(\d{2})\.(?:jpe?g|png|webp)/i.exec(text);
  if (day) return toDate(utc(day.slice(1)));

  const path = /\/Pic\/(\d{4})(\d{2})\/(\d{2})\//.exec(text);
  if (path) return toDate(utc([path[1]!, path[2]!, path[3]!]));

  return undefined;
}

/**
 * The earliest photo, which is when the ad first went up - a listing edited
 * later carries newer photos alongside the originals.
 */
function earliestImageDate(urls: string[]): Date | undefined {
  const dates = urls.map(dateFromImageUrl).filter((d): d is Date => d !== undefined);
  if (dates.length === 0) return undefined;
  return dates.reduce((earliest, d) => (d < earliest ? d : earliest));
}

/**
 * Parses a raw response body. A non-JSON body is a challenge page served with HTTP 200 -
 * a failure the health tracker must hear about, not an empty city.
 */
function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('yad2 returned a non-JSON body');
  }
}

/** Parses one feed page's raw body; see parseJsonBody for the non-JSON case. */
export function parseYad2FeedBody(body: string, fallbackCity: string): Yad2FeedPage {
  return parseYad2Feed(parseJsonBody(body), fallbackCity);
}

export function parseYad2Feed(payload: unknown, fallbackCity: string): Yad2FeedPage {
  const feed = feedSchema.safeParse(payload);
  if (!feed.success) {
    // An empty city still has both arrays. Their absence means the shape changed, or the
    // body is something else entirely, and "no listings" must not be how that looks.
    throw new Error('yad2 feed has no listing sections - the response shape changed');
  }

  const listings: Listing[] = [];
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const section of FEED_SECTIONS) {
    for (const raw of feed.data.data[section] ?? []) {
      const parsed = itemSchema.safeParse(raw);
      // One odd ad must not discard the rest of the page.
      if (!parsed.success) continue;
      // A promoted block can repeat an ad already listed in its own section.
      if (seen.has(parsed.data.token)) continue;
      seen.add(parsed.data.token);
      if (section === 'private' || section === 'agency') tokens.push(parsed.data.token);

      const listing = toListing(parsed.data, fallbackCity, brokerFor(section, parsed.data.adType));
      if (listing) listings.push(listing);
    }
  }

  return { listings, tokens, totalPages: feed.data.data.pagination?.totalPages ?? 1 };
}

/** The section says who posted the ad; the promoted sections fall back to the ad's own type. */
function brokerFor(section: FeedSection, adType: string | null | undefined): boolean | undefined {
  if (section === 'private') return false;
  if (section === 'agency') return true;
  return brokerFromAdType(adType);
}

/** Yad2 labels by-owner ads "private" and agency ads "commercial". */
function brokerFromAdType(adType: string | null | undefined): boolean | undefined {
  return adType ? adType !== 'private' : undefined;
}

/** One ad as a Listing; null for storage units, parking and other non-homes. */
function toListing(m: Yad2Item, fallbackCity: string, isBroker: boolean | undefined): Listing | null {
  const propertyType = m.additionalDetails?.property?.text ?? undefined;
  if (propertyType && NON_RESIDENTIAL.test(propertyType)) return null;

  const images = [m.metaData?.coverImage, ...(m.metaData?.images ?? [])].filter(
    (u): u is string => typeof u === 'string' && u.startsWith('https://'),
  );
  const postedAt = earliestImageDate(images);

  const street = m.address?.street?.text ?? null;
  const houseNumber = m.address?.house?.number ?? null;
  const address = street ? `${street}${houseNumber ? ` ${houseNumber}` : ''}` : undefined;
  const floor = m.address?.house?.floor;

  return {
    source: 'yad2',
    sourceId: m.token,
    url: `${ITEM_BASE}/${m.token}`,
    price: typeof m.price === 'number' && m.price > 0 ? Math.round(m.price) : null,
    rooms: m.additionalDetails?.roomsCount ?? null,
    city: m.address?.city?.text ?? fallbackCity,
    ...(m.address?.neighborhood?.text ? { neighborhood: m.address.neighborhood.text } : {}),
    ...(address ? { address } : {}),
    ...(m.address?.coords ? { lat: m.address.coords.lat, lng: m.address.coords.lon } : {}),
    ...(propertyType ? { propertyType } : {}),
    ...(m.additionalDetails?.squareMeter ? { sqm: m.additionalDetails.squareMeter } : {}),
    ...(typeof floor === 'number' ? { floor: floor === 0 ? 'קומת קרקע' : `קומה ${floor}` } : {}),
    amenities: (m.tags ?? [])
      .map((t) => t.name)
      .filter((n): n is string => Boolean(n))
      .slice(0, 6),
    // coverImage is the photo Yad2 itself leads with; images[] is the gallery.
    imageUrls: images.slice(0, 1),
    ...(postedAt ? { postedAt } : {}),
    originalSource: 'יד2',
    ...(isBroker !== undefined ? { isBroker } : {}),
    ...(typeof m.orderId === 'number' ? { sequence: m.orderId } : {}),
  };
}
