import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Geocoder } from '../src/core/geocode.js';
import { HealthTracker } from '../src/core/health.js';
import type { Notifier } from '../src/core/notifier.js';
import { PollCycle } from '../src/core/pollCycle.js';
import { findPhone, parseStatusCallback, statusCallback, STATUSES } from '../src/core/tracking.js';
import type { Listing, SavedSearch } from '../src/core/types.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { KvRepo } from '../src/db/kv.repo.js';
import { ListingsRepo } from '../src/db/listings.repo.js';
import { SearchesRepo } from '../src/db/searches.repo.js';
import { mapTokenFor, startMapServer } from '../src/web/mapServer.js';

const CHAT = 7;

function ad(overrides: Partial<Listing> = {}): Listing {
  return {
    source: 'yad2',
    sourceId: 'a',
    url: 'https://x/a',
    price: 6_000,
    rooms: 3,
    city: 'תל אביב יפו',
    address: 'הרצל 10',
    amenities: [],
    imageUrls: [],
    ...overrides,
  };
}

function newSearch(db: Db): SavedSearch {
  return new SearchesRepo(db).create({
    chatId: CHAT,
    name: 't',
    cityKeys: ['tel-aviv'],
    cityName: 'תל אביב יפו',
    minRooms: null,
    maxRooms: null,
    minPrice: null,
    maxPrice: null,
  });
}

describe('phone detection', () => {
  it.each([
    ['תתקשר 050-1234567', '050-1234567'],
    ['0521234567', '052-1234567'],
    ['054 123 4567 בערב', '054-1234567'],
    ['+972-58-123-4567', '058-1234567'],
    ['+972 50 1234567', '050-1234567'],
    ['972501234567', '050-1234567'],
  ])('reads %s', (text, phone) => {
    expect(findPhone(text)).toBe(phone);
  });

  it.each(['03-1234567', 'מחיר 6500', '05012345678', '1050-1234567'])('ignores %s', (text) => {
    expect(findPhone(text)).toBeNull();
  });
});

describe('status callback data', () => {
  it('round-trips every status within 64 bytes', () => {
    for (const { code } of STATUSES) {
      const data = statusCallback(123_456_789, code);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseStatusCallback(data)).toEqual({ id: 123_456_789, status: code });
    }
  });

  it('rejects anything else', () => {
    expect(parseStatusCallback('st:1:sold')).toBeNull();
    expect(parseStatusCallback('st:x:interested')).toBeNull();
    expect(parseStatusCallback('rm:1')).toBeNull();
  });
});

describe('tracking in the repo', () => {
  let db: Db;
  let repo: ListingsRepo;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new ListingsRepo(db);
  });

  it('shares one record between boards carrying the same flat', () => {
    const id = repo.track(ad(), CHAT);
    expect(repo.track(ad({ source: 'realta', sourceId: 'r1', url: 'https://r/1' }), CHAT)).toBe(id);
    expect(repo.track(ad(), CHAT + 1)).not.toBe(id);

    expect(repo.setStatus(id, CHAT, 'contacted')).toBe(true);
    expect(repo.setStatus(id, CHAT + 1, 'rejected')).toBe(false);
    expect(repo.trackingOf(ad({ source: 'madlan', sourceId: 'm' }), CHAT)?.status).toBe('contacted');
  });

  it('keeps the record when a price drop changes the fingerprint', () => {
    const searchId = newSearch(db).id;
    repo.seedAsSeen([ad()], searchId, CHAT);
    const id = repo.track(ad(), CHAT);
    expect(repo.track(ad({ price: 5_500 }), CHAT)).toBe(id);
  });

  it('appends notes and picks up a phone number', () => {
    const id = repo.track(ad(), CHAT);
    repo.addNote(id, CHAT, 'בעל הבית: 050-7654321');
    const saved = repo.addNote(id, CHAT, 'x'.repeat(900));
    expect(saved?.phone).toBe('050-7654321');
    expect(saved?.notes).toHaveLength(2);
    expect(saved?.notes[1]!.text).toHaveLength(500);
    expect(repo.addNote(id, CHAT + 1, 'not mine')).toBeUndefined();
  });

  it('lists rejected flats only when asked', () => {
    repo.setStatus(repo.track(ad(), CHAT), CHAT, 'rejected');
    repo.setStatus(repo.track(ad({ sourceId: 'b', price: 7_000 }), CHAT), CHAT, 'visited');
    repo.track(ad({ sourceId: 'c', price: 8_000 }), CHAT);
    expect(repo.listTracked(CHAT, false).map((t) => t.status)).toEqual(['visited']);
    expect(repo.listTracked(CHAT, true)).toHaveLength(2);
  });
});

describe('rejected flats in the poll cycle', () => {
  let current: Listing[];
  let db: Db;
  let listings: ListingsRepo;
  let cycle: PollCycle;
  const sendPriceDrop = vi.fn(async () => undefined);

  beforeEach(async () => {
    db = openDatabase(':memory:');
    listings = new ListingsRepo(db);
    const notifier = {
      setMarket: () => undefined,
      notifyChat: async () => undefined,
      notifyOwner: async () => undefined,
      sendPriceDrop,
      flushPending: async () => 0,
    } as unknown as Notifier;
    const adapter = { name: 'all', cadenceMinutes: 0, supports: () => true, fetchListings: async () => current };
    cycle = new PollCycle([adapter], new SearchesRepo(db), listings, new KvRepo(db), notifier, new HealthTracker());
    newSearch(db);
    sendPriceDrop.mockClear();
    // The first cycle seeds both sources silently.
    current = [ad(), ad({ source: 'realta', sourceId: 'seed', address: 'דיזנגוף 1' })];
    await cycle.run();
  });

  it('never alerts on another board carrying a rejected flat', async () => {
    // Rejected from a preview, before any board was recorded under its fingerprint.
    const flat = ad({ sourceId: 'p', address: 'אלנבי 5' });
    listings.setStatus(listings.track(flat, CHAT), CHAT, 'rejected');
    current = [{ ...flat, source: 'realta', sourceId: 'r2', url: 'https://r/2' }];
    await cycle.run();
    expect(listings.pending()).toHaveLength(0);
  });

  it('reports no price drop on a taken flat', async () => {
    listings.setStatus(listings.track(ad(), CHAT), CHAT, 'taken');
    current = [ad({ price: 5_000 })];
    await cycle.run();
    expect(sendPriceDrop).not.toHaveBeenCalled();
  });

  it('still alerts on flats with other statuses', async () => {
    const flat = ad({ sourceId: 'p', address: 'אלנבי 5' });
    listings.setStatus(listings.track(flat, CHAT), CHAT, 'interested');
    current = [{ ...flat, source: 'realta', sourceId: 'r2' }, ad({ price: 5_000 })];
    await cycle.run();
    expect(listings.pending()).toHaveLength(1);
    expect(sendPriceDrop).toHaveBeenCalledOnce();
  });
});

describe('map POST endpoints', () => {
  let server: ReturnType<typeof startMapServer>;
  let base: string;
  let token: string;
  let listings: ListingsRepo;

  beforeEach(async () => {
    const db = openDatabase(':memory:');
    const kv = new KvRepo(db);
    listings = new ListingsRepo(db);
    listings.seedAsSeen([ad()], newSearch(db).id, CHAT);
    token = mapTokenFor(kv, CHAT);
    server = startMapServer({ listings, kv, geocoder: new Geocoder(db), port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    server.close();
  });

  const post = (path: string, body: unknown, t = token) =>
    fetch(`${base}${path}?t=${t}`, { method: 'POST', body: JSON.stringify(body) });

  it('requires the chat token', async () => {
    expect((await post('/api/status', { ref: 'yad2:a', status: 'rejected' }, 'x'.repeat(24))).status).toBe(404);
    expect((await fetch(`${base}/api/status`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect(listings.trackingOf(ad(), CHAT)).toBeUndefined();
  });

  it('sets a status and adds a note', async () => {
    const status = await post('/api/status', { ref: 'yad2:a', status: 'visited' });
    expect(await status.json()).toEqual({ status: 'visited' });
    const note = await post('/api/note', { ref: 'yad2:a', text: 'טלפון 0501234567' });
    expect(await note.json()).toMatchObject({ status: 'visited', phone: '050-1234567' });
  });

  it('rejects bad input', async () => {
    expect((await post('/api/status', { ref: 'yad2:a', status: 'sold' })).status).toBe(400);
    expect((await post('/api/note', { ref: 'yad2:a', text: 'x'.repeat(501) })).status).toBe(400);
    expect((await post('/api/note', { ref: 'yad2:zzz', text: 'hi' })).status).toBe(404);
    const garbage = await fetch(`${base}/api/note?t=${token}`, { method: 'POST', body: 'nope' });
    expect(garbage.status).toBe(400);
  });
});
