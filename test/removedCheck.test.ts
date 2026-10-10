import { beforeEach, describe, expect, it } from 'vitest';
import { REMOVED_CHECK_KEY, REMOVED_NOTE, checkRemovedYad2, type RemovedCheckDeps } from '../src/core/removedCheck.js';
import type { Listing } from '../src/core/types.js';
import { openDatabase } from '../src/db/database.js';
import { KvRepo } from '../src/db/kv.repo.js';
import { ListingsRepo } from '../src/db/listings.repo.js';
import { SearchesRepo } from '../src/db/searches.repo.js';

const CHAT = 7;

function ad(id: string): Listing {
  return {
    source: 'yad2',
    sourceId: id,
    url: `https://x/${id}`,
    price: 6_000,
    rooms: 3,
    city: 'תל אביב יפו',
    address: `רחוב ${id}`,
    amenities: [],
    imageUrls: [],
  };
}

const gone = async (): Promise<string> => {
  throw new Error('HTTP 404 for https://gw.yad2.co.il/realestate-item/x');
};

describe('Yad2 removed-ad check', () => {
  let deps: RemovedCheckDeps;
  let listings: ListingsRepo;
  let sent: string[];
  const status = (id: string) => listings.trackingOf(ad(id), CHAT)?.status ?? null;

  beforeEach(() => {
    const db = openDatabase(':memory:');
    listings = new ListingsRepo(db);
    const searches = new SearchesRepo(db);
    const search = searches.create({
      chatId: CHAT,
      name: 't',
      cityKeys: ['tel-aviv'],
      cityName: 'תל אביב יפו',
      minRooms: 3,
      maxRooms: null,
      minPrice: null,
      maxPrice: 6_500,
    });
    listings.seedAsSeen([ad('a'), ad('b')], search.id, CHAT);
    sent = [];
    deps = { searches, listings, kv: new KvRepo(db), notifier: { notifyChat: async (_c, text) => void sent.push(text) } };
  });

  it('marks a removed ad with no status as taken', async () => {
    await checkRemovedYad2(deps, gone);
    expect(status('a')).toBe('taken');
    expect(sent).toEqual([]);
  });

  it('keeps a status the chat set, notes the removal once and reports it', async () => {
    const id = listings.track(ad('a'), CHAT);
    listings.setStatus(id, CHAT, 'contacted');
    await checkRemovedYad2(deps, gone);
    deps.kv.delete(REMOVED_CHECK_KEY);
    await checkRemovedYad2(deps, gone);
    expect(status('a')).toBe('contacted');
    expect(listings.tracked(id, CHAT)!.notes.map((n) => n.text)).toEqual([REMOVED_NOTE]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('רחוב a');
    expect(sent[0]).not.toContain('רחוב b');
  });

  it('changes nothing on any failure but a 404', async () => {
    await checkRemovedYad2(deps, async () => {
      throw new Error('HTTP 503 for https://gw.yad2.co.il/realestate-item/x');
    });
    expect(status('a')).toBeNull();
    expect(status('b')).toBeNull();
  });

  it('runs at most once a day', async () => {
    let calls = 0;
    const live = async () => String(++calls);
    const start = Date.now();
    await checkRemovedYad2(deps, live, start);
    await checkRemovedYad2(deps, live, start + 23 * 3_600_000);
    expect(calls).toBe(2);
    await checkRemovedYad2(deps, live, start + 25 * 3_600_000);
    expect(calls).toBe(4);
  });
});
