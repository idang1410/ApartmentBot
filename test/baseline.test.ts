import { beforeEach, describe, expect, it } from 'vitest';
import { HealthTracker } from '../src/core/health.js';
import type { Notifier } from '../src/core/notifier.js';
import { PollCycle, splitBySequence } from '../src/core/pollCycle.js';
import type { Listing, SavedSearch, SourceAdapter } from '../src/core/types.js';
import { openDatabase } from '../src/db/database.js';
import { KvRepo } from '../src/db/kv.repo.js';
import { ListingsRepo } from '../src/db/listings.repo.js';
import { SearchesRepo } from '../src/db/searches.repo.js';

const CHAT = 42;

function ad(sourceId: string, sequence?: number, source = 'yad2'): Listing {
  return {
    source,
    sourceId,
    url: `https://example.com/${sourceId}`,
    price: 6_000,
    rooms: 3,
    city: 'מודיעין מכבים רעות',
    amenities: [],
    imageUrls: [],
    ...(sequence !== undefined ? { sequence } : {}),
  };
}

// PollCycle only calls these; nothing here is about delivery.
const silentNotifier = {
  setMarket: () => undefined,
  notifyChat: async () => undefined,
  notifyOwner: async () => undefined,
  sendPriceDrop: async () => undefined,
  flushPending: async () => 0,
} as unknown as Notifier;

describe('splitBySequence', () => {
  it('treats every sequenced listing as back catalogue when there is no baseline yet', () => {
    const { backCatalogue, highest } = splitBySequence([ad('a', 10), ad('b', 30), ad('c')], () => undefined);
    expect(backCatalogue.map((l) => l.sourceId)).toEqual(['a', 'b']);
    expect(highest.get('yad2')).toBe(30);
  });

  it('keeps anything above the baseline, or without a sequence, out of the back catalogue', () => {
    const { backCatalogue } = splitBySequence([ad('a', 10), ad('b', 20), ad('c', 21), ad('d')], () => 20);
    expect(backCatalogue.map((l) => l.sourceId)).toEqual(['a', 'b']);
  });
});

describe('sequence baseline in the poll cycle', () => {
  let current: Listing[];
  let listings: ListingsRepo;
  let kv: KvRepo;
  let cycle: PollCycle;
  let search: SavedSearch;

  const adapter: SourceAdapter = {
    name: 'yad2',
    cadenceMinutes: 0,
    supports: () => true,
    fetchListings: async () => current,
  };
  const pendingIds = () => listings.pending().map((p) => p.listing.sourceId).sort();

  beforeEach(() => {
    const db = openDatabase(':memory:');
    const searches = new SearchesRepo(db);
    listings = new ListingsRepo(db);
    kv = new KvRepo(db);
    cycle = new PollCycle([adapter], searches, listings, kv, silentNotifier, new HealthTracker());
    search = searches.create({
      chatId: CHAT,
      name: 't',
      cityKeys: ['modiin'],
      cityName: 'מודיעין מכבים רעות',
      minRooms: null,
      maxRooms: null,
      minPrice: null,
      maxPrice: null,
    });
  });

  it('records the first fetch silently and remembers where it ended', async () => {
    current = [ad('a', 100), ad('b', 90)];
    await cycle.run();

    expect(pendingIds()).toEqual([]);
    expect(kv.get(`seq_baseline:${search.id}:yad2:modiin`)).toBe('100');
  });

  it('alerts on a bumped old ad and on one created after the baseline', async () => {
    current = [ad('a', 100), ad('b', 90)];
    await cycle.run();
    current = [ad('a', 100), ad('b', 90), ad('bumped', 95), ad('fresh', 101)];
    await cycle.run();

    expect(pendingIds()).toEqual(['bumped', 'fresh']);
  });

  it('never moves the baseline after the first fetch', async () => {
    // An ad created after it that does not match today and gets cheaper next week must
    // still alert then; a baseline that followed the newest ad would swallow it.
    current = [ad('a', 100)];
    await cycle.run();
    current = [ad('a', 100), ad('fresh', 150)];
    await cycle.run();

    expect(kv.get(`seq_baseline:${search.id}:yad2:modiin`)).toBe('100');
  });

  it('leaves listings without a sequence to the ordinary rules', async () => {
    current = [ad('a', 100), ad('h1', undefined, 'homeless')];
    await cycle.run();
    current = [ad('a', 100), ad('h1', undefined, 'homeless'), ad('h2', undefined, 'homeless')];
    await cycle.run();

    expect(pendingIds()).toEqual(['h2']);
  });

  it('sets the baseline when a search is created, so its first cycle can already alert', async () => {
    current = [ad('a', 100)];
    await cycle.seedSearch(search);
    current = [ad('a', 100), ad('bumped', 95), ad('fresh', 101)];
    await cycle.run();

    expect(pendingIds()).toEqual(['bumped', 'fresh']);
  });

  it('re-establishes an unreadable baseline instead of trusting it', async () => {
    kv.set(`seq_baseline:${search.id}:yad2:modiin`, 'garbage');
    current = [ad('a', 100), ad('b', 90)];
    await cycle.run();

    expect(pendingIds()).toEqual([]);
    expect(kv.get(`seq_baseline:${search.id}:yad2:modiin`)).toBe('100');
  });
});

describe('a city with no baseline yet', () => {
  let byCity: Record<string, Listing[]>;
  let listings: ListingsRepo;
  let cycle: PollCycle;

  const adapter: SourceAdapter = {
    name: 'yad2',
    cadenceMinutes: 0,
    supports: () => true,
    fetchListings: async (_search, city) => byCity[city.key] ?? [],
  };
  const pendingIds = () => listings.pending().map((p) => p.listing.sourceId).sort();

  beforeEach(() => {
    const db = openDatabase(':memory:');
    const searches = new SearchesRepo(db);
    listings = new ListingsRepo(db);
    cycle = new PollCycle([adapter], searches, listings, new KvRepo(db), silentNotifier, new HealthTracker());
    searches.create({
      chatId: CHAT,
      name: 't',
      cityKeys: ['modiin', 'rishon'],
      cityName: 'מודיעין מכבים רעות',
      minRooms: null,
      maxRooms: null,
      minPrice: null,
      maxPrice: null,
    });
  });

  it('alerts on the first ad in a town that had none', async () => {
    // Yad2's ad numbers are one nationwide counter, so the newest seen anywhere stands in for
    // the missing baseline. Without it the town's first ad was filed as back catalogue.
    byCity = { modiin: [ad('a', 100)], rishon: [] };
    await cycle.run();
    byCity = { modiin: [ad('a', 100)], rishon: [ad('first', 150)] };
    await cycle.run();

    expect(pendingIds()).toEqual(['first']);
  });

  it('still records an older ad silently in a town read for the first time', async () => {
    byCity = { modiin: [ad('a', 100)], rishon: [] };
    await cycle.run();
    byCity = { modiin: [ad('a', 100)], rishon: [ad('old', 90)] };
    await cycle.run();

    expect(pendingIds()).toEqual([]);
  });
});
