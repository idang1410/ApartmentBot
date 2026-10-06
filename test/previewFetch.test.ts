import { describe, expect, it } from 'vitest';
import { HealthTracker } from '../src/core/health.js';
import type { Notifier } from '../src/core/notifier.js';
import { PollCycle } from '../src/core/pollCycle.js';
import type { FetchOptions, Listing, SourceAdapter } from '../src/core/types.js';
import { openDatabase } from '../src/db/database.js';
import { KvRepo } from '../src/db/kv.repo.js';
import { ListingsRepo } from '../src/db/listings.repo.js';
import { SearchesRepo } from '../src/db/searches.repo.js';

// PollCycle only calls these; nothing here is about delivery.
const silentNotifier = {
  setMarket: () => undefined,
  notifyChat: async () => undefined,
  notifyOwner: async () => undefined,
  sendPriceDrop: async () => undefined,
  flushPending: async () => 0,
} as unknown as Notifier;

describe('which fetches count as reads', () => {
  it('flags seeding as a preview, and leaves poll cycles unflagged', async () => {
    const flags: Array<boolean | undefined> = [];
    const adapter: SourceAdapter = {
      name: 'fake',
      cadenceMinutes: 0,
      supports: () => true,
      async fetchListings(_search, _city, options?: FetchOptions): Promise<Listing[]> {
        flags.push(options?.preview);
        return [];
      },
    };
    const db = openDatabase(':memory:');
    const searches = new SearchesRepo(db);
    const listings = new ListingsRepo(db);
    const kv = new KvRepo(db);
    const cycle = new PollCycle([adapter], searches, listings, kv, silentNotifier, new HealthTracker());
    const search = searches.create({
      chatId: 1,
      name: 't',
      cityKeys: ['modiin'],
      cityName: 'מודיעין מכבים רעות',
      minRooms: null,
      maxRooms: null,
      minPrice: null,
      maxPrice: null,
    });

    await cycle.seedSearch(search);
    await cycle.run();

    expect(flags).toEqual([true, undefined]);
  });
});
