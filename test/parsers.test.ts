import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CITIES, listingCityMatches, normalizeCityName, searchCities } from '../src/core/cities.js';
import { listingSchema, type CityEntry } from '../src/core/types.js';
import { parseHomelessListings } from '../src/sources/homeless/homelessParse.js';
import { normalizeMadlanBulletins, type MadlanBulletin } from '../src/sources/madlan/madlanNormalize.js';
import { createYad2Adapter } from '../src/sources/yad2/yad2Adapter.js';

const yad2Adapter = createYad2Adapter();

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

const modiin: CityEntry = {
  key: 'modiin',
  name: 'מודיעין מכבים רעות',
  aliases: ['מודיעין-מכבים-רעות', 'מודיעין'],
  homelessRegionCode: '13',
};

describe('homeless parser', () => {
  const listings = parseHomelessListings(fixture('homeless-region.html'));

  it('extracts the usable result cards from the region feed', () => {
    // The fixture holds 10 cards; one of them publishes no city at all and so
    // could never be attributed to a search.
    expect(listings.length).toBe(9);
    expect(listings.every((l) => l.city.length > 0)).toBe(true);
  });

  it('produces listings that satisfy the shared Listing schema', () => {
    for (const listing of listings) {
      expect(() => listingSchema.parse(listing)).not.toThrow();
    }
  });

  it('reads the fields packed into the card title attribute', () => {
    const found = listings.find((l) => l.sourceId === '738743');
    expect(found).toMatchObject({
      source: 'homeless',
      rooms: 5.5,
      city: 'מודיעין מכבים רעות',
      neighborhood: 'משואה',
      address: 'עמק החולה 91',
      propertyType: 'דופלקס',
      sqm: 182,
      floor: 'קומה 3',
    });
    expect(found?.url).toBe('https://www.homeless.co.il/rent/viewad,738743.aspx');
  });

  it('reads the price from the card body', () => {
    expect(listings.find((l) => l.sourceId === '738743')?.price).toBe(11_500);
    expect(listings.find((l) => l.sourceId === '741197')?.price).toBe(15_000);
  });

  it('drops placeholder images but keeps real photos', () => {
    expect(listings.find((l) => l.sourceId === '738743')?.imageUrls).toEqual([]);
    expect(listings.find((l) => l.sourceId === '741197')?.imageUrls[0]).toMatch(/uploads\.homeless\.co\.il/);
  });

  it('does not repeat a listing that appears in both the hot strip and the list', () => {
    const ids = listings.map((l) => l.sourceId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('spells out the floor instead of leaving a bare digit', () => {
    expect(listings.find((l) => l.sourceId === '741197')?.floor).toBe('קומת קרקע');
    expect(listings.find((l) => l.sourceId === '736030')?.floor).toBe('קומה 3');
  });

  it('returns nothing for an empty document rather than throwing', () => {
    expect(parseHomelessListings('<html><body>no results</body></html>')).toEqual([]);
  });
});

describe('madlan api', () => {
  const bulletins = JSON.parse(fixture('madlan-newest.json')).data
    .searchBulletinWithUserPreferences.bulletins as MadlanBulletin[];
  const petahTikva = CITIES.find((c) => c.key === 'petah-tikva')!;

  it('produces listings that satisfy the shared Listing schema', () => {
    for (const listing of normalizeMadlanBulletins(bulletins, petahTikva)) {
      expect(() => listingSchema.parse(listing)).not.toThrow();
    }
  });

  /**
   * The feed is the whole country and both deal types at once, because the
   * API has no city filter and no rent filter we could find. Everything the
   * bot relies on therefore happens here: a ₪6,000,000 sale leaking through
   * as a rental would pass every price bound the bot has.
   */
  it('keeps only rentals, and only in the city asked for', () => {
    const listings = normalizeMadlanBulletins(bulletins, petahTikva);

    expect(listings.length).toBeGreaterThan(0);
    for (const listing of listings) {
      expect(listing.city).toMatch(/פתח תקו/);
      expect(listing.price === null || listing.price < 100_000).toBe(true);
    }
    // A different city in the same feed must come back separately.
    const haifa = CITIES.find((c) => c.key === 'haifa')!;
    const inHaifa = normalizeMadlanBulletins(bulletins, haifa);
    for (const listing of inHaifa) expect(listing.city).toBe('חיפה');
  });

  it('reads the fields the filters and the alert need', () => {
    const [listing] = normalizeMadlanBulletins(bulletins, petahTikva);
    expect(listing?.source).toBe('madlan');
    expect(listing?.url).toMatch(/^https:\/\/www\.madlan\.co\.il\/listings\/.+/);
    expect(listing?.postedAt).toBeInstanceOf(Date);
    expect(typeof listing?.rooms === 'number' || listing?.rooms === null).toBe(true);
  });

  it('reads the safe room and the building shelter', () => {
    const [first] = bulletins.filter((b) => normalizeMadlanBulletins([b], petahTikva).length > 0);
    const read = (amenities: MadlanBulletin['amenities']) =>
      normalizeMadlanBulletins([{ ...first!, amenities }], petahTikva)[0]?.amenities;
    expect(read({ secureRoom: true, miklat: false, mamak: false })).toEqual(['ממ״ד']);
    expect(read({ secureRoom: false, miklat: false, mamak: true })).toEqual(['מקלט']);
    expect(read(null)).toEqual([]);
  });

  it('maps madlan’s own seller words onto the broker flag, and guesses nothing', () => {
    const city = CITIES.find((c) => c.key === 'modiin')!;
    const row = (sellerType: unknown) => ({
      id: 'x', dealType: 'unitRent', price: 6_000, beds: 3, sellerType,
      addressDetails: { city: 'מודיעין מכבים רעות', streetName: 'הרצל' },
    });

    expect(normalizeMadlanBulletins([row('agent')], city)[0]?.isBroker).toBe(true);
    expect(normalizeMadlanBulletins([row('private')], city)[0]?.isBroker).toBe(false);
    // Unknown must stay unset: "private only" would otherwise reject it.
    expect(normalizeMadlanBulletins([row(null)], city)[0]?.isBroker).toBeUndefined();
  });

  it('returns nothing for an empty feed rather than throwing', () => {
    expect(normalizeMadlanBulletins([], petahTikva)).toEqual([]);
  });
});

describe('city matching', () => {
  it('treats hyphenated and spaced spellings as the same city', () => {
    expect(normalizeCityName('מודיעין-מכבים-רעות')).toBe('מודיעין מכבים רעות');
    expect(listingCityMatches(modiin, 'מודיעין-מכבים-רעות')).toBe(true);
    expect(listingCityMatches(modiin, 'מודיעין מכבים רעות')).toBe(true);
  });

  it('does not confuse nearby towns with similar names', () => {
    expect(listingCityMatches(modiin, 'מודיעין עילית')).toBe(false);
    expect(listingCityMatches(modiin, 'מבוא מודיעים')).toBe(false);
    expect(listingCityMatches(modiin, 'שילת')).toBe(false);
  });

  it('finds cities from partial free text typed in the wizard', () => {
    expect(searchCities('מודיעין')[0]?.key).toBe('modiin');
    expect(searchCities('רמת')[0]?.key).toBe('ramat-gan');
    expect(searchCities('')).toEqual([]);
  });
});

describe('yad2 city coverage', () => {
  /**
   * `yad2Adapter.supports` needs both codes, so a city carrying only one is
   * silently skipped by the richest source there is - no error, no empty
   * result, just a city the best board never covers. Petah Tikva was added to
   * a live search while Yad2 had no code for it and 200 listings went unread.
   */
  it('never half-configures a city', () => {
    for (const city of CITIES) {
      expect(
        Boolean(city.yad2CityCode) === Boolean(city.yad2RegionCode),
        `${city.key} has one yad2 code but not the other`,
      ).toBe(true);
    }
  });

  it('covers every city the wizard can offer', () => {
    // Yad2 is the only source left that carries the whole country, so a city
    // the picker offers but Yad2 cannot read is a city the bot cannot search.
    for (const city of CITIES) {
      expect(yad2Adapter.supports({} as never, city), `yad2 does not cover ${city.key}`).toBe(true);
    }
  });
});
