import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CITIES } from '../src/core/cities.js';
import { Geocoder, geocodeKey, geocodeQuery } from '../src/core/geocode.js';
import type { Listing } from '../src/core/types.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { KvRepo } from '../src/db/kv.repo.js';
import { ListingsRepo } from '../src/db/listings.repo.js';
import { SearchesRepo } from '../src/db/searches.repo.js';
import { normalizeMadlanBulletins } from '../src/sources/madlan/madlanNormalize.js';
import { parseOnmapListings } from '../src/sources/onmap/onmapNormalize.js';
import { parseRealtaListings } from '../src/sources/realta/realtaNormalize.js';
import { parseYad2Feed } from '../src/sources/yad2/yad2Normalize.js';
import { chatForToken, mapPins, mapTokenFor } from '../src/web/mapServer.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'));

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: 'homeless',
    sourceId: 'a',
    url: 'https://x/a',
    price: 6_000,
    rooms: 3,
    city: 'תל אביב יפו',
    amenities: [],
    imageUrls: [],
    ...overrides,
  };
}

describe('coordinates from the sources', () => {
  it('yad2 reads address.coords', () => {
    const first = parseYad2Feed(fixture('yad2-feed-tel-aviv.json'), 'תל אביב יפו').listings[0]!;
    expect(first.lat).toBeCloseTo(32.08, 1);
    expect(first.lng).toBeCloseTo(34.78, 1);
  });

  it('onmap reads address.location', () => {
    const first = parseOnmapListings(fixture('onmap-rishon.json'), 'ראשון לציון')[0]!;
    expect(first).toMatchObject({ lat: 31.9591649, lng: 34.8014437 });
  });

  it('realta reads lat and lon', () => {
    const first = parseRealtaListings(fixture('realta-modiin.json'), 'מודיעין מכבים רעות')[0]!;
    expect(first).toMatchObject({ lat: 31.903942, lng: 34.997349 });
  });

  it('madlan reads locationPoint', () => {
    const telAviv = CITIES.find((c) => c.key === 'tel-aviv')!;
    const [withPoint, without] = normalizeMadlanBulletins(
      [
        { id: 'a', dealType: 'unitRent', addressDetails: { city: 'תל אביב יפו' }, locationPoint: { lat: 32.1, lng: 34.8 } },
        { id: 'b', dealType: 'unitRent', addressDetails: { city: 'תל אביב יפו' } },
      ],
      telAviv,
    );
    expect(withPoint).toMatchObject({ lat: 32.1, lng: 34.8 });
    expect(without!.lat).toBeUndefined();
  });
});

describe('geocoding', () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('keys by normalized place and city, keeping the house number', () => {
    expect(geocodeKey('דיזנגוף  50', 'תל-אביב-יפו')).toBe('דיזנגוף 50|תל אביב יפו');
    expect(geocodeKey('דיזנגוף 50', 'תל אביב')).not.toBe(geocodeKey('דיזנגוף 52', 'תל אביב'));
  });

  it('falls back to the neighbourhood, marked approximate', () => {
    expect(geocodeQuery(listing({ address: 'דיזנגוף 50', neighborhood: 'הצפון הישן' }))).toEqual({
      place: 'דיזנגוף 50',
      city: 'תל אביב יפו',
      approximate: false,
    });
    expect(geocodeQuery(listing({ neighborhood: 'פלורנטין' }))).toMatchObject({
      place: 'פלורנטין',
      approximate: true,
    });
    expect(geocodeQuery(listing())).toBeNull();
  });

  it('caches hits and misses, asking Nominatim once per place', async () => {
    const asked: string[] = [];
    const fake = (async (url: URL) => {
      asked.push(url.searchParams.get('q')!);
      const body = url.searchParams.get('q')!.startsWith('דיזנגוף') ? [{ lat: '32.08', lon: '34.77' }] : [];
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    const geocoder = new Geocoder(db, fake);

    expect(geocoder.cached('דיזנגוף 50', 'תל אביב יפו')).toBeUndefined();
    expect(await geocoder.locate('דיזנגוף 50', 'תל אביב יפו')).toEqual({ lat: 32.08, lng: 34.77 });
    expect(await geocoder.locate('nowhere', 'תל אביב יפו')).toBeNull();
    expect(await geocoder.locate('דיזנגוף 50', 'תל-אביב-יפו')).toEqual({ lat: 32.08, lng: 34.77 });
    expect(geocoder.cached('nowhere', 'תל אביב יפו')).toBeNull();
    expect(asked).toEqual(['דיזנגוף 50, תל אביב יפו', 'nowhere, תל אביב יפו']);
  });
});

describe('map token', () => {
  it('identifies the chat it was issued to and nothing else', () => {
    const kv = new KvRepo(openDatabase(':memory:'));
    const token = mapTokenFor(kv, 42);
    expect(mapTokenFor(kv, 42)).toBe(token);
    expect(chatForToken(kv, token)).toBe(42);
    expect(chatForToken(kv, null)).toBeUndefined();
    expect(chatForToken(kv, '')).toBeUndefined();
    expect(chatForToken(kv, `${token}x`)).toBeUndefined();
    expect(chatForToken(kv, '%')).toBeUndefined();
  });
});

describe('map data', () => {
  let db: Db;
  let repo: ListingsRepo;
  let searches: SearchesRepo;
  let searchId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new ListingsRepo(db);
    searches = new SearchesRepo(db);
    searchId = searches.create({
      chatId: 1,
      name: 't',
      cityKeys: ['tel-aviv'],
      cityName: 'תל אביב יפו',
      minRooms: null,
      maxRooms: null,
      minPrice: null,
      maxPrice: null,
    }).id;
  });

  it('takes recent matches of active searches for the chat, one per fingerprint', () => {
    const a = listing({ sourceId: 'a', address: 'דיזנגוף 50' });
    const sameFlat = listing({ source: 'yad2', sourceId: 'b', address: 'דיזנגוף 50' });
    const near = listing({ sourceId: 'c', sqm: 70 });
    repo.recordPending([a, sameFlat, near], searchId, 1, (l) => (l.sourceId === 'c' ? 'near' : 'exact'));
    repo.recordPending([listing({ sourceId: 'other-chat', sqm: 80 })], searchId, 2);
    repo.recordPending([listing({ sourceId: 'old', sqm: 90 })], searchId, 1);
    db.prepare(`UPDATE seen_listings SET first_seen = datetime('now', '-20 days') WHERE listing_id = 'old'`).run();

    const matched = repo.matchedRecently(1, 14);
    expect(matched.map((m) => [m.listing.sourceId, m.matchKind]).sort()).toEqual([
      ['a', 'exact'],
      ['c', 'near'],
    ]);

    searches.setActive(searchId, false);
    expect(repo.matchedRecently(1, 14)).toEqual([]);
  });

  it('pins source coordinates, cached geocodes, and queues the rest', async () => {
    db.prepare(`INSERT INTO geocode_cache (key, lat, lng) VALUES (?, 32.06, 34.77)`).run(
      geocodeKey('פלורנטין', 'תל אביב יפו'),
    );
    const fetched: string[] = [];
    const geocoder = new Geocoder(db, (async (url: URL) => {
      fetched.push(url.searchParams.get('q')!);
      return new Response('[]');
    }) as unknown as typeof fetch);
    const row = (l: Listing) => ({ listing: l, matchKind: 'exact' as const, firstSeen: '2026-10-01 10:00:00' });

    const { pins, pending } = mapPins(
      [
        row(listing({ sourceId: 'a', lat: 32.1, lng: 34.8 })),
        row(listing({ sourceId: 'b', neighborhood: 'פלורנטין' })),
        row(listing({ sourceId: 'c', address: 'הרצל 5' })),
        row(listing({ sourceId: 'd' })),
      ],
      geocoder,
    );

    expect(pins.map((p) => [p.url, p.lat, p.approximate])).toEqual([
      ['https://x/a', 32.1, false],
      ['https://x/a', 32.06, true],
    ]);
    expect(pins[0]!.firstSeen).toBe('2026-10-01T10:00:00Z');
    expect(pending).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetched).toEqual(['הרצל 5, תל אביב יפו']);
  });
});
