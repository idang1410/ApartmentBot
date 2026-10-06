import { beforeEach, describe, expect, it } from 'vitest';
import { reviewQueue } from '../src/bot/review.js';
import type { Listing, SavedSearch } from '../src/core/types.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { ListingsRepo } from '../src/db/listings.repo.js';
import { SearchesRepo } from '../src/db/searches.repo.js';

const CHAT = 7;

function ad(id: string, overrides: Partial<Listing> = {}): Listing {
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
    ...overrides,
  };
}

describe('/review queue', () => {
  let db: Db;
  let repo: ListingsRepo;
  let search: SavedSearch;

  /** Records a listing as seen `hoursAgo` hours ago. */
  function seen(listing: Listing, hoursAgo: number): void {
    repo.seedAsSeen([listing], search.id, CHAT);
    db.prepare(`UPDATE seen_listings SET first_seen = datetime('now', ?) WHERE listing_id = ?`).run(
      `-${hoursAgo} hours`,
      listing.sourceId,
    );
  }

  const ids = (onlyUnmarked = false) =>
    reviewQueue(repo, [search], CHAT, onlyUnmarked).map((item) => item.listing.sourceId);

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new ListingsRepo(db);
    search = new SearchesRepo(db).create({
      chatId: CHAT,
      name: 't',
      cityKeys: ['tel-aviv'],
      cityName: 'תל אביב יפו',
      minRooms: 3,
      maxRooms: null,
      minPrice: null,
      maxPrice: 6_500,
    });
  });

  it('puts unmarked flats first, each group newest first', () => {
    seen(ad('1'), 3);
    seen(ad('2'), 2);
    seen(ad('3'), 1);
    repo.setStatus(repo.track(ad('3'), CHAT), CHAT, 'interested');
    expect(ids()).toEqual(['2', '1', '3']);
    expect(ids(true)).toEqual(['2', '1']);
  });

  it('drops flats marked rejected or taken', () => {
    seen(ad('1'), 1);
    seen(ad('2'), 2);
    seen(ad('3'), 3);
    repo.setStatus(repo.track(ad('1'), CHAT), CHAT, 'rejected');
    repo.setStatus(repo.track(ad('2'), CHAT), CHAT, 'taken');
    expect(ids()).toEqual(['3']);
  });

  it('checks each flat against the search as it is now', () => {
    seen(ad('small', { rooms: 2.5 }), 1);
    seen(ad('near', { price: 7_000 }), 2);
    seen(ad('far', { price: 9_000 }), 3);
    seen(ad('old'), 24 * 31);
    const queue = reviewQueue(repo, [search], CHAT, false);
    expect(queue.map((item) => [item.listing.sourceId, item.matchKind])).toEqual([['near', 'near']]);
  });

  it('shows one card per flat', () => {
    seen(ad('1'), 2);
    seen(ad('1', { source: 'madlan' }), 1);
    expect(reviewQueue(repo, [search], CHAT, false)).toHaveLength(1);
  });

  it('includes flats stored by a search that was since deleted', () => {
    const old = new SearchesRepo(db).create({ ...search, name: 'old' });
    repo.seedAsSeen([ad('1')], old.id, CHAT);
    new SearchesRepo(db).remove(old.id);
    expect(ids()).toEqual(['1']);
  });

  it('leaves out searches it was not given', () => {
    seen(ad('1'), 1);
    expect(reviewQueue(repo, [], CHAT, false)).toEqual([]);
  });
});
