import { beforeEach, describe, expect, it } from 'vitest';
import { formatDigest, orderSnapshot } from '../src/bot/digest.js';
import { HealthTracker } from '../src/core/health.js';
import { Notifier } from '../src/core/notifier.js';
import { PollCycle } from '../src/core/pollCycle.js';
import { BlockedError, type Listing, type SourceAdapter } from '../src/core/types.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { KvRepo } from '../src/db/kv.repo.js';
import { ListingsRepo } from '../src/db/listings.repo.js';
import { SearchesRepo } from '../src/db/searches.repo.js';

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: 'yad2',
    sourceId: 'a',
    url: 'https://www.yad2.co.il/realestate/item/a',
    price: 6_300,
    rooms: 3,
    city: 'מודיעין מכבים רעות',
    neighborhood: 'משואה',
    address: 'נהר הירדן 8',
    amenities: [],
    imageUrls: [],
    ...overrides,
  };
}

describe('market digest', () => {
  it('lists each flat on one line with price, rooms, place, age and a link', () => {
    const text = formatDigest(
      [listing({ postedAt: new Date(Date.now() - 3 * 86_400_000) })],
      { offset: 0, pageSize: 10, alreadySent: () => false, nearMiss: () => null },
    );
    expect(text).toContain('6,300 ₪');
    expect(text).toContain('3 חד׳');
    expect(text).toContain('נהר הירדן 8');
    expect(text).toContain('לפני 3 ימים');
    expect(text).toContain('<a href="https://www.yad2.co.il/realestate/item/a">');
  });

  it('marks what was already sent and why a near miss is near', () => {
    const text = formatDigest(
      [listing({ sourceId: 'sent' }), listing({ sourceId: 'near', price: 6_800 })],
      {
        offset: 0,
        pageSize: 10,
        alreadySent: (l) => l.sourceId === 'sent',
        nearMiss: (l) => (l.sourceId === 'near' ? '6,800 ₪ - מעל המקסימום ב-5%' : null),
      },
    );
    expect(text).toContain('✓');
    expect(text).toContain('🤏');
    expect(text).toContain('מעל המקסימום');
  });

  it('escapes listing text, since the digest is HTML', () => {
    const text = formatDigest([listing({ address: 'רחוב <b>' })], {
      offset: 0, pageSize: 10, alreadySent: () => false, nearMiss: () => null,
    });
    expect(text).toContain('&lt;b&gt;');
  });

  it('pages through a long list', () => {
    const many = Array.from({ length: 12 }, (_, i) => listing({ sourceId: `l${i}`, price: 5_000 + i }));
    const page = formatDigest(many, { offset: 10, pageSize: 10, alreadySent: () => false, nearMiss: () => null });
    expect(page).toContain('5,010 ₪');
    expect(page).not.toContain('5,000 ₪');
  });
});

describe('seeding a search', () => {
  let db: Db;
  let calls: string[];
  let cycle: PollCycle;
  let searches: SearchesRepo;

  const fake: SourceAdapter = {
    name: 'fake',
    cadenceMinutes: 0,
    supports: () => true,
    async fetchListings(_search, city) {
      calls.push(city.key);
      return [listing({ city: city.name, sourceId: `${city.key}-1` })];
    },
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    calls = [];
    searches = new SearchesRepo(db);
    const listings = new ListingsRepo(db);
    const kv = new KvRepo(db);
    cycle = new PollCycle([fake], searches, listings, kv, new Notifier({} as never, listings, searches, kv), new HealthTracker());
  });

  const create = (maxPrice: number | null) =>
    searches.create({
      chatId: 1, name: 't', cityKeys: ['modiin'], cityName: 'מודיעין מכבים רעות',
      minRooms: null, maxRooms: null, minPrice: null, maxPrice,
    });

  it('returns the seeded snapshot so a caller can show the market without refetching', async () => {
    const a = create(null);
    const { seeded, snapshot } = await cycle.seedSearch(a);
    expect(seeded).toBe(1);
    expect(snapshot.all).toHaveLength(1);
  });
});

describe('the market list collapses one flat carried by several boards', () => {
  const snapshot = (matching: Listing[], near: Listing[] = []) => ({ matching, near, all: [...matching, ...near] });

  /**
   * Measured on real data: a 134-card market list carried 14 flats twice or more,
   * 16 redundant cards. The alert stream already collapsed these; the market
   * list pooled every source and showed them all.
   */
  it('shows a flat once however many boards carry it', () => {
    const ordered = orderSnapshot(
      snapshot([
        listing({ source: 'realta', sourceId: 'r', address: 'אושה', sqm: 90 }),
        listing({ source: 'onmap', sourceId: 'o', address: 'אושה 12', sqm: 90 }),
        listing({ source: 'komo', sourceId: 'k', address: 'רחוב אושה', sqm: 88 }),
      ]),
      () => false,
    );

    expect(ordered).toHaveLength(1);
    // The first copy wins, and ordering runs before collapsing, so the one
    // kept is the best-ranked - never an already-sent or near-miss copy.
    expect(ordered[0]?.source).toBe('realta');
  });

  it('keeps genuinely different flats', () => {
    const ordered = orderSnapshot(
      snapshot([
        listing({ sourceId: 'a', address: 'אושה 3', price: 6_000 }),
        listing({ sourceId: 'b', address: 'הרצל 9', price: 6_000 }),
      ]),
      () => false,
    );

    expect(ordered).toHaveLength(2);
  });

  it('prefers the exact match when the same flat is also a near miss', () => {
    const exact = listing({ source: 'realta', sourceId: 'r', address: 'אושה' });
    const asNear = listing({ source: 'onmap', sourceId: 'o', address: 'אושה' });
    const ordered = orderSnapshot(snapshot([exact], [asNear]), () => false);

    expect(ordered).toHaveLength(1);
    expect(ordered[0]?.source).toBe('realta');
  });

  it('keeps every copy of a listing too vague to fingerprint', () => {
    const vague = (id: string) => listing({ sourceId: id, price: null, address: undefined });
    const ordered = orderSnapshot(snapshot([vague('a'), vague('b')]), () => false);

    expect(ordered).toHaveLength(2);
  });
});

describe('seeding does not fetch sources the poll cycle would skip', () => {
  let db: Db;
  let searches: SearchesRepo;
  let health: HealthTracker;
  let calls: string[];

  const named = (name: string, fetch: () => Promise<Listing[]>): SourceAdapter => ({
    name,
    cadenceMinutes: 0,
    supports: () => true,
    async fetchListings() {
      calls.push(name);
      return fetch();
    },
  });

  const build = (adapters: SourceAdapter[]) => {
    const listings = new ListingsRepo(db);
    const kv = new KvRepo(db);
    return new PollCycle(
      adapters, searches, listings, kv,
      new Notifier({} as never, listings, searches, kv), health,
    );
  };

  const search = () =>
    searches.create({
      chatId: 1, name: 't', cityKeys: ['modiin'], cityName: 'מודיעין מכבים רעות',
      minRooms: null, maxRooms: null, minPrice: null, maxPrice: null,
    });

  beforeEach(() => {
    db = openDatabase(':memory:');
    searches = new SearchesRepo(db);
    health = new HealthTracker();
    calls = [];
  });

  /**
   * Madlan answers a bot-protection page in 15-40 seconds and has never
   * returned a listing. The poll cycle backs off from it, and seeding must too.
   */
  it('skips a source that is in backoff after being blocked', async () => {
    health.recordFailure('blocked', new BlockedError('blocked', 'bot page'), true);
    const cycle = build([named('blocked', async () => []), named('fine', async () => [listing()])]);

    await cycle.seedSearch(search());

    expect(calls).toEqual(['fine']);
  });
});
