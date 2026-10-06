import { describe, expect, it } from 'vitest';
import { findCityByKey } from '../src/core/cities.js';
import { BlockedError, type CityEntry, type SavedSearch } from '../src/core/types.js';
import {
  MAX_PAGES,
  MIN_PAGES,
  feedUrl,
  createYad2Adapter,
  type FeedFetcher,
} from '../src/sources/yad2/yad2Adapter.js';

const telAviv = findCityByKey('tel-aviv')!;
const search = { id: 1 } as SavedSearch;

function ad(token: string, city = 'תל אביב יפו') {
  return {
    token,
    adType: 'private',
    price: 6_000,
    orderId: 1_000,
    address: { city: { text: city } },
    additionalDetails: { property: { text: 'דירה' }, roomsCount: 3 },
  };
}

function page(tokens: string[], totalPages = 100): string {
  return JSON.stringify({
    data: { private: tokens.map((t) => ad(t)), agency: [], pagination: { totalPages } },
  });
}

/** Page N of a walk holds `${walk}${N}a` and `${walk}${N}b`. */
const tokensFor = (walk: string, n: number) => [`${walk}${n}a`, `${walk}${n}b`];

function recording(bodyFor: (page: number) => string) {
  const calls: number[] = [];
  const fetchPage: FeedFetcher = async (_city: CityEntry, n: number) => {
    calls.push(n);
    return bodyFor(n);
  };
  return { calls, fetchPage };
}

const pages = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

describe('yad2 page walking', () => {
  it('reads deep on its first walk, when everything is new - the catch-up after a restart', async () => {
    const { calls, fetchPage } = recording((n) => page(tokensFor('x', n)));
    const listings = await createYad2Adapter(fetchPage).fetchListings(search, telAviv);
    expect(calls).toEqual(pages(MAX_PAGES));
    expect(listings).toHaveLength(MAX_PAGES * 2);
  });

  it('stops after the minimum once a walk finds nothing new', async () => {
    const { calls, fetchPage } = recording((n) => page(tokensFor('x', n)));
    const adapter = createYad2Adapter(fetchPage);
    await adapter.fetchListings(search, telAviv);
    calls.length = 0;

    await adapter.fetchListings(search, telAviv);
    expect(calls).toEqual(pages(MIN_PAGES));
  });

  it('keeps reading while pages still hold something new', async () => {
    // The feed is ordered by last update, so new ads can sit below a page of bumps.
    let fresh = false;
    const { calls, fetchPage } = recording((n) =>
      page(fresh && n <= 3 ? [`new${n}`, ...tokensFor('x', n)] : tokensFor('x', n)),
    );
    const adapter = createYad2Adapter(fetchPage);
    await adapter.fetchListings(search, telAviv);
    calls.length = 0;
    fresh = true;

    const listings = await adapter.fetchListings(search, telAviv);
    expect(calls).toEqual([1, 2, 3, 4]);
    expect(listings.map((l) => l.sourceId)).toEqual(expect.arrayContaining(['new1', 'new2', 'new3']));
  });

  it('never asks for a page past the end of the feed', async () => {
    const { calls, fetchPage } = recording(() => page(['only'], 1));
    await createYad2Adapter(fetchPage).fetchListings(search, telAviv);
    expect(calls).toEqual([1]);
  });

  it('remembers each city separately', async () => {
    const { calls, fetchPage } = recording((n) => page(tokensFor('x', n)));
    const adapter = createYad2Adapter(fetchPage);
    await adapter.fetchListings(search, telAviv);
    calls.length = 0;

    await adapter.fetchListings(search, findCityByKey('rishon')!);
    expect(calls).toEqual(pages(MAX_PAGES));
  });

  it('lets a preview read deep without counting what it read', async () => {
    // New-search seeding never alerts. If its reads counted, the next poll
    // cycle would stop early and never hand those ads to the alert path.
    const { calls, fetchPage } = recording((n) => page(tokensFor('x', n)));
    const adapter = createYad2Adapter(fetchPage);
    await adapter.fetchListings(search, telAviv, { preview: true });
    expect(calls).toEqual(pages(MAX_PAGES));
    calls.length = 0;

    await adapter.fetchListings(search, telAviv);
    expect(calls).toEqual(pages(MAX_PAGES));
  });

  it('lets a preview use what poll cycles have read', async () => {
    const { calls, fetchPage } = recording((n) => page(tokensFor('x', n)));
    const adapter = createYad2Adapter(fetchPage);
    await adapter.fetchListings(search, telAviv);
    calls.length = 0;

    await adapter.fetchListings(search, telAviv, { preview: true });
    expect(calls).toEqual(pages(MIN_PAGES));
  });

  it('keeps earlier pages when a later one fails', async () => {
    const { fetchPage } = recording((n) => {
      if (n === 2) throw new Error('socket hang up');
      return page(tokensFor('x', n));
    });
    const listings = await createYad2Adapter(fetchPage).fetchListings(search, telAviv);
    expect(listings.map((l) => l.sourceId)).toEqual(['x1a', 'x1b']);
  });

  it('reads deep again after a walk that was cut short', async () => {
    // The pages below the failure were never read. Counting the ones above as read would
    // make the next walk stop at page 2 and lose the catch-up for good.
    let failing = true;
    const { calls, fetchPage } = recording((n) => {
      if (failing && n === 4) throw new Error('socket hang up');
      return page(tokensFor('x', n));
    });
    const adapter = createYad2Adapter(fetchPage);
    await adapter.fetchListings(search, telAviv);
    failing = false;
    calls.length = 0;

    await adapter.fetchListings(search, telAviv);
    expect(calls).toEqual(pages(MAX_PAGES));
  });

  it('reads deep again after a block', async () => {
    let blocked = true;
    const { calls, fetchPage } = recording((n) => {
      if (blocked && n === 3) throw new BlockedError('yad2', 'Radware firewall event');
      return page(tokensFor('x', n));
    });
    const adapter = createYad2Adapter(fetchPage);
    await expect(adapter.fetchListings(search, telAviv)).rejects.toBeInstanceOf(BlockedError);
    blocked = false;
    calls.length = 0;

    await adapter.fetchListings(search, telAviv);
    expect(calls).toEqual(pages(MAX_PAGES));
  });

  it('throws when the first page fails, so the city never just looks empty', async () => {
    const { fetchPage } = recording(() => {
      throw new Error('HTTP 500');
    });
    await expect(createYad2Adapter(fetchPage).fetchListings(search, telAviv)).rejects.toThrow('HTTP 500');
  });

  it('throws a block on any page, so the source backs off', async () => {
    const { fetchPage } = recording((n) => {
      if (n === 2) throw new BlockedError('yad2', 'Radware firewall event');
      return page(tokensFor('x', n));
    });
    await expect(createYad2Adapter(fetchPage).fetchListings(search, telAviv)).rejects.toBeInstanceOf(
      BlockedError,
    );
  });

  it('drops listings from other cities', async () => {
    const body = JSON.stringify({
      data: { private: [ad('here'), ad('there', 'רמת גן')], agency: [], pagination: { totalPages: 1 } },
    });
    const { fetchPage } = recording(() => body);
    const listings = await createYad2Adapter(fetchPage).fetchListings(search, telAviv);
    expect(listings.map((l) => l.sourceId)).toEqual(['here']);
  });

  it('skips a city it has no codes for', () => {
    expect(createYad2Adapter().supports(search, { key: 'nowhere', name: 'x', aliases: [] })).toBe(false);
    expect(createYad2Adapter().supports(search, telAviv)).toBe(true);
  });
});

describe('the yad2 feed url', () => {
  it('zero-pads a city code below 1000, as Yad2 writes it', () => {
    // Sent as 168, Kfar Yona came back an empty city with HTTP 200; as 0168 it has listings.
    const kfarYona = { key: 'kefar-yona', name: 'כפר יונה', aliases: [], yad2CityCode: 168, yad2RegionCode: 1 };
    expect(feedUrl(kfarYona, 1)).toBe(
      'https://gw.yad2.co.il/realestate-feed/rent/feed?region=1&city=0168&page=1',
    );
  });

  it('leaves a four-digit code alone and sends nothing but region, city and page', () => {
    expect(feedUrl(telAviv, 3)).toBe(
      'https://gw.yad2.co.il/realestate-feed/rent/feed?region=3&city=5000&page=3',
    );
  });
});
