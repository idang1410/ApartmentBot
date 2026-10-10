import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findCityByKey } from '../src/core/cities.js';
import { DEEP_PREFIX } from '../src/core/deepSearch.js';
import { HealthTracker } from '../src/core/health.js';
import type { Notifier } from '../src/core/notifier.js';
import { PollCycle } from '../src/core/pollCycle.js';
import { BlockedError, type Listing, type SavedSearch, type SourceAdapter } from '../src/core/types.js';
import { openDatabase } from '../src/db/database.js';
import { KvRepo } from '../src/db/kv.repo.js';
import { ListingsRepo } from '../src/db/listings.repo.js';
import { SearchesRepo } from '../src/db/searches.repo.js';
import { madlanAdapter, resetMadlanCache } from '../src/sources/madlan/madlanAdapter.js';
import { onmapAdapter } from '../src/sources/onmap/onmapAdapter.js';
import { realtaAdapter } from '../src/sources/realta/realtaAdapter.js';
import { fetchText } from '../src/util/http.js';
import { createFacebookAdapter } from '../src/sources/facebook/fbAdapter.js';
import { readGroupPosts } from '../src/sources/facebook/fbBrowser.js';
import { FACEBOOK_GROUPS } from '../src/sources/facebook/fbGroups.js';

vi.mock('../src/sources/facebook/fbBrowser.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sources/facebook/fbBrowser.js')>()),
  openContext: vi.fn(async () => ({ close: async () => undefined })),
  readGroupPosts: vi.fn(async () => []),
}));
vi.mock('../src/llm/extractPosts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/llm/extractPosts.js')>()),
  extractPosts: vi.fn(async () => new Map()),
}));
vi.mock('../src/util/http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/util/http.js')>()),
  fetchText: vi.fn(),
}));

const CHAT = 42;
const modiin = findCityByKey('modiin')!;

function ad(sourceId: string, source: string, price = 6_000): Listing {
  return {
    source,
    sourceId,
    url: `https://example.com/${source}/${sourceId}`,
    price,
    rooms: 3,
    city: 'מודיעין מכבים רעות',
    amenities: [],
    imageUrls: [],
  };
}

describe('the deep search in the poll cycle', () => {
  let db: ReturnType<typeof openDatabase>;
  let listings: ListingsRepo;
  let kv: KvRepo;
  let searches: SearchesRepo;
  let health: HealthTracker;
  let messages: string[];
  let search: SavedSearch;
  let steps: Record<string, number[]>;
  let blocked: boolean;

  const notifier = () =>
    ({
      setMarket: () => undefined,
      notifyChat: async (_chat: number, text: string) => void messages.push(text),
      notifyOwner: async () => undefined,
      sendPriceDrop: async () => undefined,
      flushPending: async () => 0,
    }) as unknown as Notifier;

  /** A source with `units` pages of two ads each, read two pages a step; one ad is over budget. */
  const source = (name: string, units: number): SourceAdapter => ({
    name,
    cadenceMinutes: 0,
    supports: () => true,
    fetchListings: async () => [],
    deepSearch: async (_city, from) => {
      if (blocked && name === 'yad2') throw new BlockedError('yad2', 'Radware firewall event');
      (steps[name] ??= []).push(from);
      const read = Array.from({ length: Math.min(2, units - from) }, (_, i) => from + i);
      return {
        listings: read.flatMap((u) => [ad(`${u}a`, name), ad(`${u}b`, name, 99_000)]),
        next: from + 2 >= units ? null : from + 2,
        total: units,
      };
    },
  });

  const cycleWith = (adapters: SourceAdapter[]) =>
    new PollCycle(adapters, searches, listings, kv, notifier(), health);

  beforeEach(() => {
    db = openDatabase(':memory:');
    searches = new SearchesRepo(db);
    listings = new ListingsRepo(db);
    kv = new KvRepo(db);
    health = new HealthTracker();
    messages = [];
    steps = {};
    blocked = false;
    search = searches.create({
      chatId: CHAT,
      name: 't',
      cityKeys: ['modiin'],
      cityName: modiin.name,
      minRooms: null,
      maxRooms: null,
      minPrice: null,
      maxPrice: 7_000,
    });
  });

  it('starts by itself, takes one step a cycle, and resumes from kv after a restart', async () => {
    await cycleWith([source('yad2', 5)]).run();
    expect(steps.yad2).toEqual([0]);
    expect(JSON.parse(kv.get(`${DEEP_PREFIX}yad2:modiin`)!)).toMatchObject({ next: 2, total: 5 });

    // A new PollCycle is a restart: only kv carries the place.
    await cycleWith([source('yad2', 5)]).run();
    await cycleWith([source('yad2', 5)]).run();
    expect(steps.yad2).toEqual([0, 2, 4]);

    await cycleWith([source('yad2', 5)]).run();
    expect(steps.yad2).toEqual([0, 2, 4]);
  });

  it('records matches for /review without alerting, and sends summaries instead', async () => {
    const cycle = cycleWith([source('yad2', 4), source('realta', 2)]);
    await cycle.run();
    await cycle.run();

    expect(listings.pending()).toEqual([]);
    const recorded = listings
      .matchedRecently(CHAT, 30)
      .map((m) => `${m.listing.source}:${m.listing.sourceId}`);
    expect(recorded.sort()).toEqual(['realta:0a', 'realta:1a', 'yad2:0a', 'yad2:1a', 'yad2:2a', 'yad2:3a']);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain('realta');
    expect(messages[0]).toContain('2 דירות מתאימות');
    expect(messages[2]).toContain('yad2: 4');
    expect(messages[2]).toContain('realta: 2');
    expect(messages[2]).toContain('/review new');
  });

  it('does not count listings the chat has already seen', async () => {
    listings.seedAsSeen([ad('0a', 'yad2')], search.id, CHAT);
    await cycleWith([source('yad2', 2)]).run();
    expect(messages[0]).toContain('1 דירות מתאימות');
  });

  it('refuses /deep while one is in progress, and restarts every source once all are done', async () => {
    const cycle = cycleWith([source('yad2', 2), source('realta', 4)]);
    expect(cycle.deep.restartAll()).toBe(false);
    await cycle.run();
    expect(cycle.deep.restartAll()).toBe(false);
    expect(cycle.deep.progress(CHAT)).toEqual([
      'yad2 · מודיעין מכבים רעות: ✅ הושלם · 2 מתאימות',
      'realta · מודיעין מכבים רעות: 🔄 2/4 · 2 מתאימות',
    ]);
    await cycle.run();

    expect(cycle.deep.restartAll()).toBe(true);
    expect(JSON.parse(kv.get(`${DEEP_PREFIX}yad2:modiin`)!)).toEqual({ next: 0, found: {} });
    await cycle.run();
    expect(steps.yad2).toEqual([0, 0]);
  });

  it('stops a blocked source without moving it, and backs it off', async () => {
    blocked = true;
    const cycle = cycleWith([source('yad2', 4)]);
    await cycle.run();
    expect(steps.yad2).toBeUndefined();
    expect(health.get('yad2').backoffCycles).toBeGreaterThan(0);
    expect(JSON.parse(kv.get(`${DEEP_PREFIX}yad2:modiin`) ?? '{"next":0}').next).toBe(0);

    blocked = false;
    health.recordSuccess('yad2');
    await cycle.run();
    expect(steps.yad2).toEqual([0]);
  });

  it('takes one Facebook step at most, across both Facebook sources, every 15 minutes', async () => {
    const adapters = [source('facebook', 6), source('facebook-marketplace', 6), source('yad2', 6)];
    await cycleWith(adapters).run();
    expect(steps.facebook).toEqual([0]);
    expect(steps['facebook-marketplace']).toBeUndefined();

    // A restart does not reset the gap.
    await cycleWith(adapters).run();
    expect(steps.facebook).toEqual([0]);
    expect(steps.yad2).toEqual([0, 2]);

    kv.set('deep_last_facebook', new Date(Date.now() - 15 * 60_000).toISOString());
    await cycleWith(adapters).run();
    expect(steps.facebook).toEqual([0, 2]);
    expect(steps['facebook-marketplace']).toBeUndefined();
  });

  it('leaves a city alone while the bot is paused', async () => {
    kv.setBoolean('global_paused', true);
    await cycleWith([source('yad2', 4)]).run();
    expect(steps.yad2).toBeUndefined();
  });
});

describe('deep paging per source', () => {
  beforeEach(() => {
    vi.mocked(fetchText).mockReset();
    resetMadlanCache();
  });

  const realtaFixture = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'realta-modiin.json'), 'utf8'),
  );
  // Dated today, so no page ends on an ad too old to alert.
  const realtaPayload = {
    ...realtaFixture,
    properties: realtaFixture.properties.map((p: object) => ({ ...p, publishedAt: new Date().toISOString() })),
  };

  it('realta ends at a page whose last ad is older than 30 days', async () => {
    vi.mocked(fetchText).mockResolvedValue(JSON.stringify(realtaFixture));
    expect((await realtaAdapter.deepSearch!(modiin, 0)).next).toBeNull();
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it('realta pages by offset from where it was, and ends at a short page', async () => {
    vi.mocked(fetchText).mockImplementation(async (url) => {
      const offset = Number(/offset=(\d+)/.exec(String(url))?.[1]);
      return JSON.stringify(
        offset >= 150
          ? { ...realtaPayload, properties: realtaPayload.properties.slice(0, 5) }
          : realtaPayload,
      );
    });
    const step = await realtaAdapter.deepSearch!(modiin, 1);
    const offsets = vi.mocked(fetchText).mock.calls.map(([url]) => /offset=(\d+)/.exec(String(url))?.[1]);
    expect(offsets).toEqual(['50', '100', '150']);
    expect(step.next).toBeNull();
  });

  it('realta reads ten pages a step, then hands back its place', async () => {
    vi.mocked(fetchText).mockResolvedValue(JSON.stringify(realtaPayload));
    const step = await realtaAdapter.deepSearch!(modiin, 0);
    expect(fetchText).toHaveBeenCalledTimes(10);
    expect(step.next).toBe(10);
  });

  it('realta stops at its 200-page cap', async () => {
    vi.mocked(fetchText).mockResolvedValue(JSON.stringify(realtaPayload));
    expect((await realtaAdapter.deepSearch!(modiin, 195)).next).toBeNull();
    expect(fetchText).toHaveBeenCalledTimes(5);
  });

  it('onmap pages by $skip and ends at a short page', async () => {
    const onmap = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'onmap-rishon.json'), 'utf8'),
    );
    const rishon = findCityByKey('rishon')!;
    const full = {
      data: Array.from({ length: 100 }, (_, i) => ({ ...onmap.data[i % onmap.data.length], _id: `p${i}` })),
    };
    vi.mocked(fetchText).mockImplementation(async (url) =>
      JSON.stringify(String(url).includes('$skip=300') ? onmap : full),
    );
    const step = await onmapAdapter.deepSearch!(rishon, 2);
    const skips = vi.mocked(fetchText).mock.calls.map(([url]) => /\$skip=(\d+)/.exec(String(url))?.[1]);
    expect(skips).toEqual(['200', '300']);
    expect(step.next).toBeNull();
  });

  it('madlan pages until bulletins are 30 days old, and shares pages between cities', async () => {
    const day = 86_400_000;
    const bulletins = (page: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        id: `m${page}-${i}`,
        dealType: 'unitRent',
        price: 6_000,
        beds: 3,
        lastUpdated: new Date(Date.now() - (page * 16 + 1) * day).toISOString(),
        addressDetails: { city: 'מודיעין מכבים רעות' },
      }));
    vi.mocked(fetchText).mockImplementation(async (_url, options) => {
      const offset = (options as { json: { variables: { q: { offset: number } } } }).json.variables.q.offset;
      return JSON.stringify({
        data: { searchBulletinWithUserPreferences: { bulletins: bulletins(offset / 100) } },
      });
    });

    const first = await madlanAdapter.deepSearch!(modiin, 0);
    expect(fetchText).toHaveBeenCalledTimes(3);
    expect(first.next).toBeNull();
    expect(first.listings.length).toBeGreaterThan(0);

    await madlanAdapter.deepSearch!(findCityByKey('rishon')!, 0);
    expect(fetchText).toHaveBeenCalledTimes(3);
  });
});

describe('the facebook groups deep search', () => {
  it('reads only the fixed area groups, one per step', async () => {
    const telAviv = findCityByKey('tel-aviv')!;
    const fixed = FACEBOOK_GROUPS['tel-aviv']!;
    const adapter = createFacebookAdapter({ find: () => undefined });

    const first = await adapter.deepSearch!(telAviv, 0);
    expect(vi.mocked(readGroupPosts).mock.calls[0]?.[1]).toBe(fixed[0]);
    expect(first).toMatchObject({ next: 1, total: fixed.length });
    expect((await adapter.deepSearch!(telAviv, fixed.length - 1)).next).toBeNull();
    expect((await adapter.deepSearch!(findCityByKey('rishon')!, 0)).next).toBeNull();
  });
});
