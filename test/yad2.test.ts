import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listingSchema, type Listing } from '../src/core/types.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { ListingsRepo } from '../src/db/listings.repo.js';
import { SearchesRepo } from '../src/db/searches.repo.js';
import { dateFromImageUrl, parseYad2Feed, parseYad2FeedBody, parseYad2ItemBody } from '../src/sources/yad2/yad2Normalize.js';

const feedPayload = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'yad2-feed-tel-aviv.json'), 'utf8'),
);

const feed = parseYad2Feed(feedPayload, 'תל אביב יפו');

describe('photo dates', () => {
  it('recovers a posting date from the photo url, since the API has no date field', () => {
    // Yad2 stores images under a path ending in an upload timestamp:
    // .../y2_1pa_010595_20260816161412.jpeg -> 2026-08-16 16:14:12
    const parsed = dateFromImageUrl(
      'https://img.yad2.co.il/Pic/202608/16/2_6/o/y2_1pa_010595_20260816161412.jpeg?c=6',
    );
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(7);
    expect(parsed?.getDate()).toBe(16);
  });

  it('rejects urls with no timestamp, and nonsense stamps', () => {
    expect(dateFromImageUrl('https://img.yad2.co.il/Pic/nopic.jpg')).toBeUndefined();
    expect(dateFromImageUrl(null)).toBeUndefined();
    expect(dateFromImageUrl('https://x/_19990101000000.jpg')).toBeUndefined();
  });
});

describe('yad2 feed parser', () => {
  it('reads every real ad on the page and nothing from the promoted blocks', () => {
    // 20 private + 20 agency + 3 platinum + 1 booster. trio, leadingBroker and kingOfTheHar
    // are paid placements with no token and photos as old as 2010; yad1 is new projects for sale.
    expect(feed.listings).toHaveLength(44);
  });

  it('walks by the organic ads only, because the promoted slots rotate on every request', () => {
    // Counting platinum/booster made every page look new, so every walk ran to MAX_PAGES.
    expect(feed.tokens).toHaveLength(40);
    const promoted = [...feedPayload.data.platinum, ...feedPayload.data.booster].map(
      (ad: { token: string }) => ad.token,
    );
    expect(feed.tokens.some((token) => promoted.includes(token))).toBe(false);
  });

  it('produces listings that satisfy the shared Listing schema', () => {
    for (const listing of feed.listings) {
      expect(() => listingSchema.parse(listing)).not.toThrow();
    }
  });

  it('takes broker status from the section the ad sits in', () => {
    expect(feed.listings.filter((l) => l.isBroker === false)).toHaveLength(20);
    expect(feed.listings.filter((l) => l.isBroker === true)).toHaveLength(24);
  });

  it('carries the ad number as the creation sequence', () => {
    expect(feed.listings.find((l) => l.sourceId === 'blvd1s31')?.sequence).toBe(57217275);
    expect(feed.listings.every((l) => typeof l.sequence === 'number')).toBe(true);
  });

  it('reports how many pages the city has', () => {
    expect(feed.totalPages).toBe(173);
  });

  it('builds a working item url from the listing token', () => {
    for (const listing of feed.listings) {
      expect(listing.url).toMatch(/^https:\/\/www\.yad2\.co\.il\/realestate\/item\/\w+$/);
    }
  });

  it('renders ground floor in words rather than "קומה 0"', () => {
    for (const listing of feed.listings) {
      expect(listing.floor).not.toBe('קומה 0');
    }
  });

  it('dates most of the feed from photo urls, which is what makes the 30-day rule work', () => {
    const dated = feed.listings.filter((l) => l.postedAt instanceof Date);
    expect(dated.length).toBeGreaterThan(feed.listings.length / 2);
  });

  it('drops storage units and other non-homes but still counts their tokens', () => {
    // Page walking compares tokens, so a page of storage units is still a page read.
    const storage = {
      ...feedPayload.data.private[0],
      token: 'storage1',
      additionalDetails: { property: { text: 'מחסן' }, roomsCount: null },
    };
    const page = parseYad2Feed({ data: { private: [storage], agency: [] } }, 'x');
    expect(page.listings).toEqual([]);
    expect(page.tokens).toEqual(['storage1']);
  });

  it('skips a malformed ad without losing the rest of the page', () => {
    const page = parseYad2Feed(
      { data: { private: [{ price: 5 }, feedPayload.data.private[0]], agency: [] } },
      'x',
    );
    expect(page.tokens).toEqual(['blvd1s31']);
  });

  it('counts an ad once when a promoted block repeats it', () => {
    const ad = feedPayload.data.private[0];
    const page = parseYad2Feed({ data: { private: [ad], agency: [], platinum: [ad] } }, 'x');
    expect(page.listings).toHaveLength(1);
    expect(page.listings[0]?.isBroker).toBe(false);
  });

  it('assumes a single page when the feed gives no pagination', () => {
    expect(parseYad2Feed({ data: { private: [], agency: [] } }, 'x').totalPages).toBe(1);
  });

  it('throws on a body that is not JSON', () => {
    expect(() => parseYad2FeedBody('<html><title>x</title></html>', 'x')).toThrow(/non-JSON/);
  });

  it('throws when the listing sections are missing, rather than reporting an empty city', () => {
    // An empty city still has both arrays. Their absence means the shape changed or the body
    // is something else, and "no listings" must not be how that looks.
    expect(() => parseYad2Feed({ message: 'OK' }, 'x')).toThrow(/no listing sections/);
    expect(() => parseYad2Feed(null, 'x')).toThrow(/no listing sections/);
  });
});

describe('price drops', () => {
  let db: Db;
  let repo: ListingsRepo;
  let searchId: number;

  const listing = (price: number): Listing => ({
    source: 'yad2',
    sourceId: 'abc123',
    url: 'https://www.yad2.co.il/realestate/item/abc123',
    price,
    rooms: 3,
    city: 'מודיעין מכבים רעות',
    amenities: [],
    imageUrls: [],
  });

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new ListingsRepo(db);
    searchId = new SearchesRepo(db).create({
      chatId: 1,
      name: 't',
      cityKeys: ['modiin'],
      cityName: 'מודיעין מכבים רעות',
      minRooms: null,
      maxRooms: null,
      minPrice: null,
      maxPrice: null,
    }).id;
  });

  it('reports a listing that got cheaper', () => {
    repo.seedAsSeen([listing(7_000)], searchId, 1);

    const drops = repo.findPriceDrops([listing(6_500)], 1);
    expect(drops).toHaveLength(1);
    expect(drops[0]?.previousPrice).toBe(7_000);
    expect(drops[0]?.listing.price).toBe(6_500);
  });

  it('does not report the same drop twice', () => {
    repo.seedAsSeen([listing(7_000)], searchId, 1);

    expect(repo.findPriceDrops([listing(6_500)], 1)).toHaveLength(1);
    expect(repo.findPriceDrops([listing(6_500)], 1)).toHaveLength(0);
  });

  it('ignores price rises', () => {
    repo.seedAsSeen([listing(6_000)], searchId, 1);
    expect(repo.findPriceDrops([listing(6_800)], 1)).toHaveLength(0);
  });

  it('ignores listings it has never seen before', () => {
    // Those are new listings, and are alerted through the normal path.
    expect(repo.findPriceDrops([listing(6_000)], 1)).toHaveLength(0);
  });

  it('ignores listings with no price on either side', () => {
    repo.seedAsSeen([{ ...listing(6_000), price: null }], searchId, 1);
    expect(repo.findPriceDrops([listing(5_000)], 1)).toHaveLength(0);
    expect(repo.findPriceDrops([{ ...listing(6_000), price: null }], 1)).toHaveLength(0);
  });

  it('reports a further drop after the first one', () => {
    repo.seedAsSeen([listing(7_000)], searchId, 1);

    expect(repo.findPriceDrops([listing(6_500)], 1)).toHaveLength(1);
    const second = repo.findPriceDrops([listing(6_000)], 1);
    expect(second).toHaveLength(1);
    expect(second[0]?.previousPrice).toBe(6_500);
  });
});

describe('yad2 item parser', () => {
  const body = readFileSync(join(import.meta.dirname, 'fixtures', 'yad2-item-tel-aviv.json'), 'utf8');

  it('reads the ad, its flags and its description', () => {
    const item = parseYad2ItemBody(body, '')!;
    expect(item.rental).toBe(true);
    expect(() => listingSchema.parse(item.listing)).not.toThrow();
    expect(item.listing).toMatchObject({
      source: 'yad2',
      sourceId: 'm58o2wkc',
      url: 'https://www.yad2.co.il/realestate/item/m58o2wkc',
      price: 10_000,
      rooms: 3,
      sqm: 75,
      floor: 'קומה 1',
      city: 'תל אביב יפו',
      neighborhood: 'פלורנטין',
      address: 'נחלת בנימין 139',
      lat: 32.056814,
      lng: 34.771828,
      isBroker: false,
      sequence: 57583014,
      amenities: ['מעלית', 'מרפסת', 'ממ״ד', 'מיזוג', 'חיות מחמד'],
      imageUrls: ['https://img.yad2.co.il/Pic/202610/06/2_2/o/y2_1pa_010875_20261006144414.jpeg'],
    });
    expect(item.listing.description).toMatch(/^להשכרה דירת 3 חדרים/);
  });

  it('labels a shelter in the building', () => {
    const payload = JSON.parse(body);
    payload.data.inProperty = { includeBuildingShelter: true };
    expect(parseYad2ItemBody(JSON.stringify(payload), '')!.listing.amenities).toEqual(['מקלט']);
  });

  it('fails on a body that is not an ad', () => {
    expect(() => parseYad2ItemBody('<html><title>x</title></html>', '')).toThrow('non-JSON');
  });
});
