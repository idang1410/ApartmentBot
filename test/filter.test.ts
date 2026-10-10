import { describe, expect, it } from 'vitest';
import {
  MAX_LISTING_AGE_DAYS,
  classifyMatch,
  describeSearch,
  isFreshEnough,
  matchesSearch,
  meetsRequirements,
  nearMissReason,
} from '../src/core/filter.js';
import { describeAreas, parseRange } from '../src/bot/addWizard.js';
import { formatListing } from '../src/bot/format.js';
import type { Listing, SavedSearch } from '../src/core/types.js';
import {
  formatQuietHours,
  isWithinQuietHours,
  parseEntryDate,
  parsePostedDate,
  parseQuietHours,
} from '../src/util/time.js';

function search(overrides: Partial<SavedSearch> = {}): SavedSearch {
  return {
    id: 1,
    chatId: 1,
    name: 'test',
    cityKeys: ['modiin'],
    cityName: 'מודיעין מכבים רעות',
    minRooms: null,
    maxRooms: null,
    minPrice: null,
    maxPrice: null,
    active: true,
    createdAt: '',
    ...overrides,
  };
}

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: 'homeless',
    sourceId: '1',
    url: 'https://example.com/1',
    price: 6_000,
    rooms: 3,
    city: 'מודיעין מכבים רעות',
    amenities: [],
    imageUrls: [],
    ...overrides,
  };
}

describe('search matching', () => {
  it('accepts a listing priced exactly at the limit', () => {
    expect(matchesSearch(listing({ price: 6_500 }), search({ maxPrice: 6_500 }))).toBe(true);
  });

  it('rejects a listing one shekel over the limit', () => {
    expect(matchesSearch(listing({ price: 6_501 }), search({ maxPrice: 6_500 }))).toBe(false);
  });

  it('applies the lower price bound as well', () => {
    expect(matchesSearch(listing({ price: 2_000 }), search({ minPrice: 3_000 }))).toBe(false);
    expect(matchesSearch(listing({ price: 3_000 }), search({ minPrice: 3_000 }))).toBe(true);
  });

  it('handles half rooms against an open-ended minimum', () => {
    expect(matchesSearch(listing({ rooms: 2.5 }), search({ minRooms: 3 }))).toBe(false);
    expect(matchesSearch(listing({ rooms: 3.5 }), search({ minRooms: 3 }))).toBe(true);
  });

  it('applies a closed room range at both ends', () => {
    const range = search({ minRooms: 3, maxRooms: 4 });
    expect(matchesSearch(listing({ rooms: 3 }), range)).toBe(true);
    expect(matchesSearch(listing({ rooms: 4 }), range)).toBe(true);
    expect(matchesSearch(listing({ rooms: 4.5 }), range)).toBe(false);
  });

  it('keeps listings whose room count is unpublished', () => {
    expect(matchesSearch(listing({ rooms: null }), search({ minRooms: 4 }))).toBe(true);
  });

  it('drops listings that publish no price, even when the search has no price bound', () => {
    // "מחיר לא צוין" ads are mostly brokers withholding the figure to get a
    // call; the owner asked not to see them at all (2026-09-14).
    expect(matchesSearch(listing({ price: null }), search({ maxPrice: 5_000 }))).toBe(false);
    expect(matchesSearch(listing({ price: null }), search())).toBe(false);
  });

  it('accepts everything when the search has no bounds', () => {
    expect(matchesSearch(listing({ price: 99_000, rooms: 12 }), search())).toBe(true);
  });
});

describe('listing freshness', () => {
  const now = new Date('2026-08-25T12:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

  it('rejects the 2023 listing that a popularity-ordered board served us', () => {
    const stale = listing({ postedAt: new Date('2023-08-10') });
    expect(isFreshEnough(stale, now)).toBe(false);
    expect(matchesSearch(stale, search())).toBe(false);
  });

  it('keeps recent listings', () => {
    expect(isFreshEnough(listing({ postedAt: daysAgo(0) }), now)).toBe(true);
    expect(isFreshEnough(listing({ postedAt: daysAgo(30) }), now)).toBe(true);
  });

  it('keeps listings with no date, since most boards publish none', () => {
    // Dropping undated listings would silence the bot on most sources.
    expect(isFreshEnough(listing(), now)).toBe(true);
  });

  it('drops old Yad2 ads like any other', () => {
    expect(isFreshEnough(listing({ source: 'yad2', postedAt: daysAgo(MAX_LISTING_AGE_DAYS + 60) }), now)).toBe(false);
  });

  it('draws the line at the configured age', () => {
    expect(isFreshEnough(listing({ postedAt: daysAgo(MAX_LISTING_AGE_DAYS) }), now)).toBe(true);
    expect(isFreshEnough(listing({ postedAt: daysAgo(MAX_LISTING_AGE_DAYS + 1) }), now)).toBe(false);
  });
});

describe('posted-date parsing', () => {
  const now = new Date('2026-08-25T12:00:00Z');

  it('reads the relative wording Israeli boards use', () => {
    expect(parsePostedDate('היום', now)?.toDateString()).toBe(now.toDateString());
    expect(parsePostedDate('אתמול', now)?.toDateString()).toBe(
      new Date(now.getTime() - 86_400_000).toDateString(),
    );
    expect(parsePostedDate('לפני 3 ימים', now)?.toDateString()).toBe(
      new Date(now.getTime() - 3 * 86_400_000).toDateString(),
    );
  });

  it('reads day-first numeric dates, which is how Israeli sites write them', () => {
    // 10/08/2023 is 10 August 2023, not 8 October.
    const parsed = parsePostedDate('10/08/2023', now);
    expect(parsed?.getFullYear()).toBe(2023);
    expect(parsed?.getMonth()).toBe(7);
    expect(parsed?.getDate()).toBe(10);
  });

  it('treats hours and minutes ago as today', () => {
    expect(parsePostedDate('לפני 4 שעות', now)?.toDateString()).toBe(now.toDateString());
  });

  it('returns null when there is no date, rather than guessing', () => {
    expect(parsePostedDate(null)).toBeNull();
    expect(parsePostedDate('')).toBeNull();
    expect(parsePostedDate('דירה יפה')).toBeNull();
  });
});

describe('search description', () => {
  it('describes an open-ended room minimum with a budget cap', () => {
    expect(describeSearch(search({ minRooms: 3, maxPrice: 6_500 }))).toBe(
      'מודיעין מכבים רעות · 3+ חד׳ · עד 6,500 ₪',
    );
  });

  it('describes closed ranges on both fields', () => {
    expect(describeSearch(search({ minRooms: 3, maxRooms: 4, minPrice: 4_000, maxPrice: 6_000 }))).toBe(
      'מודיעין מכבים רעות · 3–4 חד׳ · 4,000–6,000 ₪',
    );
  });

  it('falls back to just the city when nothing is constrained', () => {
    expect(describeSearch(search())).toBe('מודיעין מכבים רעות');
  });
});

describe('wizard range parsing', () => {
  it('reads a plain number as a single value', () => {
    expect(parseRange('3')).toEqual({ min: 3, max: 3, openEnded: false });
  });

  it('reads the open-ended form used by the "3+" button', () => {
    expect(parseRange('3-')).toEqual({ min: 3, max: 3, openEnded: true });
  });

  it('reads a closed range, including halves and en dashes', () => {
    expect(parseRange('2.5-4')).toEqual({ min: 2.5, max: 4, openEnded: false });
    expect(parseRange('4000–6500')).toEqual({ min: 4000, max: 6500, openEnded: false });
  });

  it('rejects nonsense instead of guessing', () => {
    expect(parseRange('abc')).toBeNull();
    expect(parseRange('')).toBeNull();
    expect(parseRange('6-3')).toBeNull(); // max below min
  });
});

describe('quiet hours', () => {
  it('parses and re-formats a window', () => {
    const window = parseQuietHours('23:00-07:30');
    expect(window).toEqual({ startMinutes: 1_380, endMinutes: 450 });
    expect(formatQuietHours(window!)).toBe('23:00-07:30');
  });

  it('rejects malformed or empty windows', () => {
    expect(parseQuietHours('nonsense')).toBeNull();
    expect(parseQuietHours('25:00-07:00')).toBeNull();
    expect(parseQuietHours('23:00-23:00')).toBeNull();
  });

  it('covers the hours on both sides of midnight', () => {
    const night = parseQuietHours('23:00-07:30')!;
    expect(isWithinQuietHours(night, at(23, 30))).toBe(true);
    expect(isWithinQuietHours(night, at(3, 0))).toBe(true);
    expect(isWithinQuietHours(night, at(7, 29))).toBe(true);
    expect(isWithinQuietHours(night, at(7, 30))).toBe(false);
    expect(isWithinQuietHours(night, at(12, 0))).toBe(false);
  });

  it('handles a window that does not cross midnight', () => {
    const day = parseQuietHours('09:00-17:00')!;
    expect(isWithinQuietHours(day, at(12, 0))).toBe(true);
    expect(isWithinQuietHours(day, at(8, 59))).toBe(false);
  });
});

describe('message formatting', () => {
  it('includes the facts a decision needs', () => {
    const text = formatListing(
      listing({
        price: 6_000,
        rooms: 3,
        sqm: 85,
        floor: 'קומה 2',
        floorsTotal: 6,
        neighborhood: 'נחל ירקון',
        address: 'נחל הירקון 5',
        propertyType: 'דירה',
        amenities: ['חניה', 'ממ״ד'],
        originalSource: 'יד2',
        source: 'realta',
      }),
      'מודיעין · עד 6,500 ₪',
    );

    expect(text).toContain('6,000 ₪');
    expect(text).toContain('3 חד׳');
    expect(text).toContain('85 מ״ר');
    expect(text).toContain('נחל הירקון 5');
    expect(text).toContain('קומה 2 מתוך 6');
    expect(text).toContain('חניה · ממ״ד');
    // The board a listing actually came from matters more than the aggregator.
    expect(text).toContain('יד2');
  });

  it('does not repeat the search criteria the owner already chose', () => {
    const text = formatListing(listing({ price: 6_000 }), 'מודיעין · 2–4 חד׳ · 5,000–6,500 ₪');
    expect(text).not.toContain('5,000–6,500');
    expect(text).not.toContain('מודיעין · 2–4');
  });

  it('says so plainly when there is no price', () => {
    expect(formatListing(listing({ price: null }))).toContain('מחיר לא צוין');
  });

  it('flags agency listings, and says so explicitly when a flat is not one', () => {
    expect(formatListing(listing({ isBroker: true }))).toContain('תיווך');
    expect(formatListing(listing({ isBroker: false }))).toContain('ללא תיווך');
  });

  it('escapes characters that would break Telegram HTML', () => {
    const text = formatListing(listing({ neighborhood: '<b>hack</b> & "co"' }));
    expect(text).toContain('&lt;b&gt;hack&lt;/b&gt; &amp; &quot;co&quot;');
  });

  it('stays inside the Telegram caption limit however long the ad text is', () => {
    const text = formatListing(listing({ description: 'א'.repeat(5_000) }));
    expect(text.length).toBeLessThanOrEqual(1_024);
  });
});

function at(hours: number, minutes: number): Date {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date;
}

describe('near-miss matching', () => {
  const band = search({ minRooms: 3, maxRooms: 4, minPrice: 5_000, maxPrice: 6_500 });

  it('classifies a listing inside every bound as exact', () => {
    expect(classifyMatch(listing({ price: 6_000, rooms: 3.5 }), band)).toBe('exact');
  });

  it('classifies a price just under the minimum as near', () => {
    // dorin sent the owner a ₪4,950 flat that a ₪5,000 floor had hidden.
    expect(classifyMatch(listing({ price: 4_950, rooms: 3 }), band)).toBe('near');
  });

  it('classifies a price up to 10% over the maximum as near, and more as no match', () => {
    expect(classifyMatch(listing({ price: 7_000, rooms: 3 }), band)).toBe('near');
    expect(classifyMatch(listing({ price: 7_300, rooms: 3 }), band)).toBeNull();
  });

  it('classifies half a room over as near, and any room short as no match', () => {
    expect(classifyMatch(listing({ price: 6_000, rooms: 2.5 }), band)).toBeNull();
    expect(classifyMatch(listing({ price: 6_000, rooms: 4.5 }), band)).toBe('near');
    expect(classifyMatch(listing({ price: 6_000, rooms: 2 }), band)).toBeNull();
  });

  it('never relaxes the area or the age', () => {
    const streets = search({ ...band, areas: { modiin: ['עמק איילון'] } });
    expect(classifyMatch(listing({ price: 6_000, rooms: 3, address: 'נחל צין 3' }), streets)).toBeNull();

    const old = new Date(Date.now() - (MAX_LISTING_AGE_DAYS + 5) * 86_400_000);
    expect(classifyMatch(listing({ price: 6_000, rooms: 3, postedAt: old }), band)).toBeNull();
  });

  it('keeps unknown rooms as exact, like the strict filter does', () => {
    expect(classifyMatch(listing({ rooms: null }), band)).toBe('exact');
  });

  it('treats an unpublished price as no match, not a near miss', () => {
    expect(classifyMatch(listing({ price: null, rooms: 3 }), band)).toBeNull();
  });

  it('agrees with the strict filter on what is exact', () => {
    for (const l of [listing({ price: 6_000, rooms: 3 }), listing({ price: 4_950, rooms: 3 }), listing({ price: 9_000, rooms: 3 })]) {
      expect(classifyMatch(l, band) === 'exact').toBe(matchesSearch(l, band));
    }
  });

  it('explains a near miss in the owner’s terms', () => {
    expect(nearMissReason(listing({ price: 4_950, rooms: 3 }), band)).toBe('4,950 ₪ - מתחת למינימום ב-1%');
    expect(nearMissReason(listing({ price: 7_000, rooms: 3 }), band)).toBe('7,000 ₪ - מעל המקסימום ב-8%');
    expect(nearMissReason(listing({ price: 7_000, rooms: 4.5 }), band)).toBe(
      '7,000 ₪ - מעל המקסימום ב-8% · 4.5 חד׳ - חצי חדר יותר מהמקסימום',
    );
  });

  it('has nothing to explain for an exact match', () => {
    expect(nearMissReason(listing({ price: 6_000, rooms: 3 }), band)).toBeNull();
  });
});

describe('facebook date stamps', () => {
  const now = new Date('2026-08-25T12:00:00Z');

  it('reads the Hebrew day-and-month stamp a group post shows', () => {
    const parsed = parsePostedDate('15 באוגוסט ב-22:14', now);
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(7);
    expect(parsed?.getDate()).toBe(15);
  });

  it('assumes a month that has not come yet this year was last year', () => {
    expect(parsePostedDate('3 בדצמבר', now)?.getFullYear()).toBe(2025);
  });
});

describe('area summary', () => {
  it('escapes typed area names, because the confirmation screen is HTML', () => {
    // A typed "<תיווך>" once made Telegram reject the whole screen.
    expect(describeAreas({ modiin: ['<תיווך>', 'עמק איילון'] }, ['modiin'])).toContain('&lt;תיווך&gt;');
  });

  it('says nothing when no area is chosen', () => {
    expect(describeAreas({}, ['modiin'])).toBe('');
  });
});

describe('attribute requirements', () => {
  const flat = listing({ amenities: ['חניה', 'מעלית'], isBroker: false, sqm: 85, propertyType: 'דירה', description: 'דירה משופצת עם נוף' });

  it('passes when every required amenity is present, whatever the quote marks', () => {
    expect(meetsRequirements(listing({ amenities: ['ממ"ד', 'חניה'] }), { amenities: ['ממ״ד'] })).toBe('exact');
    expect(meetsRequirements(flat, { amenities: ['חניה', 'מעלית'] })).toBe('exact');
  });

  it('accepts a ממ״ד where a shelter is required, but not the reverse', () => {
    expect(meetsRequirements(listing({ amenities: ['ממ"ד'] }), { amenities: ['מקלט'] })).toBe('exact');
    expect(meetsRequirements(listing({ amenities: ['מקלט'] }), { amenities: ['מקלט'] })).toBe('exact');
    expect(meetsRequirements(listing({ amenities: ['מקלט'] }), { amenities: ['ממ״ד'] })).toBe('near');
  });

  it('treats exactly one missing amenity as a near miss, and two as no match', () => {
    // dorin's "flexible filtering": a flat missing one nice-to-have is still worth a look.
    expect(meetsRequirements(flat, { amenities: ['חניה', 'מרפסת'] })).toBe('near');
    expect(meetsRequirements(flat, { amenities: ['מרפסת', 'גינה'] })).toBeNull();
  });

  it('keeps private-only searches free of agencies, but does not drop the unknown', () => {
    expect(meetsRequirements(listing({ isBroker: true }), { brokers: 'private-only' })).toBeNull();
    expect(meetsRequirements(listing({ isBroker: false }), { brokers: 'private-only' })).toBe('exact');
    expect(meetsRequirements(listing(), { brokers: 'private-only' })).toBe('exact');
  });

  it('applies a minimum size only when the size is published', () => {
    expect(meetsRequirements(listing({ sqm: 60 }), { minSqm: 80 })).toBeNull();
    expect(meetsRequirements(listing({ sqm: 80 }), { minSqm: 80 })).toBe('exact');
    expect(meetsRequirements(listing(), { minSqm: 80 })).toBe('exact');
  });

  it('restricts property types when asked, ignoring listings that name none', () => {
    expect(meetsRequirements(listing({ propertyType: 'דירת גן' }), { propertyTypes: ['דירה'] })).toBeNull();
    expect(meetsRequirements(listing({ propertyType: 'דירה' }), { propertyTypes: ['דירה', 'דירת גן'] })).toBe('exact');
    expect(meetsRequirements(listing(), { propertyTypes: ['דירה'] })).toBe('exact');
  });

  it('requires every keyword to appear somewhere in the ad', () => {
    expect(meetsRequirements(flat, { keywords: ['נוף'] })).toBe('exact');
    expect(meetsRequirements(flat, { keywords: ['נוף', 'בריכה'] })).toBeNull();
    expect(meetsRequirements(listing({ address: 'עמק איילון 4' }), { keywords: ['עמק איילון'] })).toBe('exact');
  });

  it('is exact with no requirements at all', () => {
    expect(meetsRequirements(listing(), {})).toBe('exact');
    expect(meetsRequirements(listing(), undefined)).toBe('exact');
  });

  it('feeds into the overall classification and its explanation', () => {
    const s = search({ maxPrice: 6_500, requirements: { amenities: ['חניה', 'מרפסת'], brokers: 'private-only' } });
    expect(classifyMatch(flat, s)).toBe('near');
    expect(nearMissReason(flat, s)).toBe('חסר: מרפסת');
    expect(classifyMatch(listing({ ...flat, isBroker: true }), s)).toBeNull();
    // A price near miss and a missing amenity together are still one near miss, with both reasons.
    expect(nearMissReason(listing({ ...flat, price: 6_800 }), s)).toBe('6,800 ₪ - מעל המקסימום ב-5% · חסר: מרפסת');
  });

  it('shows up in the search description', () => {
    expect(describeSearch(search({ requirements: { amenities: ['חניה'], brokers: 'private-only', minSqm: 80 } }))).toBe(
      'מודיעין מכבים רעות · חניה · ללא תיווך · 80+ מ״ר',
    );
  });
});

describe('entry date parsing', () => {
  const now = new Date('2026-09-08T12:00:00Z');

  it('reads "immediately" as today', () => {
    expect(parseEntryDate('מיידי', now)?.toDateString()).toBe(now.toDateString());
    expect(parseEntryDate('כניסה מיידית', now)?.toDateString()).toBe(now.toDateString());
  });

  it('reads a day and month without a year as the next such date', () => {
    const parsed = parseEntryDate('1.10', now);
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(9);
    expect(parsed?.getDate()).toBe(1);
    // A date already passed this year means next year.
    expect(parseEntryDate('15/3', now)?.getFullYear()).toBe(2027);
  });

  it('reads a full date and a Hebrew month with a position word', () => {
    expect(parseEntryDate('1.11.2026', now)?.getMonth()).toBe(10);
    expect(parseEntryDate('אמצע אוקטובר', now)?.getDate()).toBe(15);
    expect(parseEntryDate('סוף ספטמבר', now)?.getDate()).toBe(28);
    expect(parseEntryDate('תחילת נובמבר', now)?.getDate()).toBe(1);
  });

  it('returns null for text that carries no date', () => {
    expect(parseEntryDate(null, now)).toBeNull();
    expect(parseEntryDate('גמיש', now)).toBeNull();
  });
});

describe('entry date with a day and a Hebrew month', () => {
  it('keeps the day instead of defaulting to the 1st', () => {
    const now = new Date('2026-09-08T12:00:00Z');
    const parsed = parseEntryDate('כניסה 15 באוקטובר', now);
    expect(parsed?.getMonth()).toBe(9);
    expect(parsed?.getDate()).toBe(15);
  });
});
