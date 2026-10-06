import { beforeEach, describe, expect, it } from 'vitest';
import { HealthTracker } from '../src/core/health.js';
import type { Notifier } from '../src/core/notifier.js';
import { PollCycle, isCadenceDue } from '../src/core/pollCycle.js';
import type { SourceAdapter } from '../src/core/types.js';
import { openDatabase } from '../src/db/database.js';
import { KvRepo } from '../src/db/kv.repo.js';
import { ListingsRepo } from '../src/db/listings.repo.js';
import { SearchesRepo } from '../src/db/searches.repo.js';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);
const agoMinutes = (n: number) => new Date(NOW - n * MINUTE).toISOString();

/** Cadence is wall-clock minutes, so it means the same thing whatever POLL_MINUTES is. */
const EVERY_CYCLE = 0;
const HOURLY = 60;
const DAILY = 24 * 60;

describe('source cadence', () => {
  it('runs an every-cycle source unconditionally', () => {
    expect(isCadenceDue(agoMinutes(0), EVERY_CYCLE, NOW)).toBe(true);
  });

  it('runs a slow source that has never run', () => {
    // Adding a source should not mean waiting out its full interval first.
    expect(isCadenceDue(undefined, DAILY, NOW)).toBe(true);
  });

  it('does not re-run a daily source that ran minutes ago', () => {
    // The bug this fixes: the cycle counter lived in memory, so a restart
    // made every source due again. Five restarts meant five Madlan fetches.
    expect(isCadenceDue(agoMinutes(5), DAILY, NOW)).toBe(false);
    expect(isCadenceDue(agoMinutes(60), DAILY, NOW)).toBe(false);
    expect(isCadenceDue(agoMinutes(23 * 60), DAILY, NOW)).toBe(false);
  });

  it('runs a daily source once the day has passed', () => {
    expect(isCadenceDue(agoMinutes(24 * 60), DAILY, NOW)).toBe(true);
    expect(isCadenceDue(agoMinutes(48 * 60), DAILY, NOW)).toBe(true);
  });

  it('allows a minute of slack so jitter does not cost a whole cycle', () => {
    // A source 30 seconds short of its day should still go.
    expect(isCadenceDue(agoMinutes(1439.6), DAILY, NOW)).toBe(true);
    expect(isCadenceDue(agoMinutes(1400), DAILY, NOW)).toBe(false);
  });

  it('honours a shorter cadence too', () => {
    expect(isCadenceDue(agoMinutes(30), HOURLY, NOW)).toBe(false);
    expect(isCadenceDue(agoMinutes(60), HOURLY, NOW)).toBe(true);
  });

  it('means the same interval whatever the poll interval is', () => {
    // Cadence used to be counted in cycles, so changing POLL_MINUTES silently
    // changed how often every slow source ran. Minutes are minutes.
    expect(isCadenceDue(agoMinutes(59.5), HOURLY, NOW)).toBe(true);
    expect(isCadenceDue(agoMinutes(45), HOURLY, NOW)).toBe(false);
  });

  it('never wedges a source off on an unreadable or future timestamp', () => {
    expect(isCadenceDue('not a date', DAILY, NOW)).toBe(true);
    // A clock that moved backwards must not silence a source indefinitely.
    expect(isCadenceDue(agoMinutes(-500), DAILY, NOW)).toBe(true);
  });
});

describe('forced cycles', () => {
  let calls: string[];
  let cycle: PollCycle;

  const source = (name: string): SourceAdapter => ({
    name,
    cadenceMinutes: DAILY,
    supports: () => true,
    async fetchListings() {
      calls.push(name);
      return [];
    },
  });

  // PollCycle only calls these; nothing here is about delivery.
  const silentNotifier = {
    setMarket: () => undefined,
    notifyChat: async () => undefined,
    notifyOwner: async () => undefined,
    flushPending: async () => 0,
  } as unknown as Notifier;

  beforeEach(async () => {
    const db = openDatabase(':memory:');
    const searches = new SearchesRepo(db);
    const listings = new ListingsRepo(db);
    cycle = new PollCycle(
      [source('madlan'), source('facebook'), source('facebook-marketplace')],
      searches, listings, new KvRepo(db), silentNotifier, new HealthTracker(),
    );
    searches.create({
      chatId: 1, name: 't', cityKeys: ['modiin'], cityName: 'מודיעין מכבים רעות',
      minRooms: null, maxRooms: null, minPrice: null, maxPrice: null,
    });
    // Every source has now just run.
    await cycle.run();
    calls = [];
  });

  it('a normal cycle still honours cadence', async () => {
    await cycle.run();
    expect(calls).toEqual([]);
  });

  it('runs a source whose cadence has not elapsed, but not Facebook within ten minutes', async () => {
    expect(cycle.forcedSkips()).toEqual(['facebook', 'facebook-marketplace']);
    const result = await cycle.run({ force: true });
    expect(calls).toEqual(['madlan']);
    expect(result.bySource).toEqual({ madlan: { listings: 0, failures: 0 } });
  });
});
