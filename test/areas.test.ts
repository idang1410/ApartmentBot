import { beforeEach, describe, expect, it } from 'vitest';
import {
  expandArea,
  findCityByKey,
  isKnownAreaName,
  listingCityMatches,
  normalizePlace,
} from '../src/core/cities.js';
import { withinAreas } from '../src/core/filter.js';
import type { Listing, SavedSearch } from '../src/core/types.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { ListingsRepo } from '../src/db/listings.repo.js';
import { SearchesRepo } from '../src/db/searches.repo.js';

function search(overrides: Partial<SavedSearch> = {}): SavedSearch {
  return {
    id: 1,
    chatId: 1,
    name: 's',
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
    source: 'yad2',
    sourceId: 'a',
    url: 'https://x/a',
    price: 6_000,
    rooms: 3,
    city: 'מודיעין מכבים רעות',
    amenities: [],
    imageUrls: [],
    ...overrides,
  };
}

describe('normalizePlace', () => {
  it('strips the house number so a street matches itself', () => {
    // The normalized form is a comparison key, never shown to anyone - the
    // wizard prints the raw spelling a source published. So the
    // invariant is that both forms agree, not what the key happens to be.
    expect(normalizePlace('רוטשילד 64')).toBe('רוטשילד');
    expect(normalizePlace('עמק איילון 4')).toBe(normalizePlace('עמק איילון'));
    expect(normalizePlace('עמק איילון 4')).not.toBe(normalizePlace('עמק חפר'));
  });

  it('collapses the spellings sources actually use', () => {
    const forms = ['רמב"ם', "רמב''ם", 'רמב``ם'];
    const [first] = forms.map(normalizePlace);
    for (const f of forms) expect(normalizePlace(f)).toBe(first);
  });

  it('drops a leading street word', () => {
    expect(normalizePlace('רחוב הרצל')).toBe('הרצל');
    expect(normalizePlace('שדרות הרכס')).toBe('הרכס');
  });

  /**
   * Full and defective spelling (כתיב מלא/חסר) is a choice each board makes
   * for itself. Realta publishes "נוה הדרים" where the region alias says
   * "נווה הדרים", and that single vav was enough for a "צפון ראשון" filter
   * to drop the listing without a word.
   */
  it('collapses full and defective spellings of the same name', () => {
    expect(normalizePlace('נווה הדרים')).toBe(normalizePlace('נוה הדרים'));
    expect(normalizePlace('קריית גנים')).toBe(normalizePlace('קרית גנים'));
    expect(normalizePlace('פתח תקווה')).toBe(normalizePlace('פתח תקוה'));
  });

  it('does not merge names that merely begin alike', () => {
    expect(normalizePlace('מודיעין עילית')).not.toBe(normalizePlace('מודיעין'));
    expect(normalizePlace('נווה חוף')).not.toBe(normalizePlace('נווה הדרים'));
  });
});

describe('city matching', () => {
  /**
   * Guards the reason `listingCityMatches` compares exactly: a looser test
   * makes "מודיעין עילית", a different town, answer to "מודיעין". Spelling
   * normalisation must not reopen that.
   */
  it('still refuses a different town with a similar name', () => {
    const modiin = findCityByKey('modiin')!;
    expect(listingCityMatches(modiin, 'מודיעין')).toBe(true);
    expect(listingCityMatches(modiin, 'מודיעין עילית')).toBe(false);
  });

  it('accepts either spelling of a city written both ways', () => {
    const petahTikva = findCityByKey('petah-tikva')!;
    expect(listingCityMatches(petahTikva, 'פתח תקווה')).toBe(true);
    expect(listingCityMatches(petahTikva, 'פתח תקוה')).toBe(true);
  });
});

describe('area filtering', () => {
  it('lets everything through when no area is chosen', () => {
    expect(withinAreas(listing({ address: 'כלשהו 3' }), search())).toBe(true);
    expect(withinAreas(listing(), search({ areas: {} }))).toBe(true);
    expect(withinAreas(listing(), search({ areas: { modiin: [] } }))).toBe(true);
  });

  it('keeps a listing on a chosen street, house number and all', () => {
    const s = search({ areas: { modiin: ['עמק איילון'] } });
    expect(withinAreas(listing({ address: 'עמק איילון 4' }), s)).toBe(true);
  });

  it('drops a listing on a street that was not chosen', () => {
    const s = search({ areas: { modiin: ['עמק איילון'] } });
    expect(withinAreas(listing({ address: 'נחל צין 34' }), s)).toBe(false);
  });

  it('matches on the neighbourhood too, not only the street', () => {
    const s = search({ areas: { modiin: ['בוכמן'] } });
    expect(withinAreas(listing({ neighborhood: 'בוכמן', address: 'כלשהו 1' }), s)).toBe(true);
  });

  it('matches a neighbourhood written with a qualifier', () => {
    // Real data contains "משואה (גבעת C)" alongside plain "משואה".
    const s = search({ areas: { modiin: ['משואה'] } });
    expect(withinAreas(listing({ neighborhood: 'משואה (גבעת C)' }), s)).toBe(true);
  });

  it('does not take a place that only names the city as the area', () => {
    const s = search({ cityKeys: ['tel-aviv'], areas: { 'tel-aviv': ['צפון יפו'] } });
    const jaffa = (neighborhood: string) => listing({ city: 'תל אביב יפו', neighborhood });
    expect(withinAreas(jaffa('יפו'), s)).toBe(false);
    expect(withinAreas(jaffa('תל אביב-יפו'), s)).toBe(false);
    expect(withinAreas(jaffa('צפון יפו, המושבה האמריקאית-גרמנית'), s)).toBe(true);
    expect(withinAreas(jaffa('שוק הפשפשים'), s)).toBe(true);
    expect(withinAreas(jaffa('גבעת הרצל, אזור המלאכה יפו'), s)).toBe(true);
    expect(withinAreas(jaffa('מכללת תל אביב יפו, דקר'), search({ cityKeys: ['tel-aviv'], areas: { 'tel-aviv': ['מרכז יפו'] } }))).toBe(true);
  });

  it('hides listings that publish no street or neighbourhood at all', () => {
    // The chosen behaviour: asking for two streets should not deliver ads
    // with no address. About 6% of listings are affected.
    const s = search({ areas: { modiin: ['עמק איילון'] } });
    expect(withinAreas(listing(), s)).toBe(false);
  });

  it('still delivers address-less listings when no area is chosen', () => {
    expect(withinAreas(listing(), search())).toBe(true);
  });

  it('applies each city’s areas only to that city', () => {
    // Picking streets in Modi'in must not silently filter Rishon.
    const s = search({
      cityKeys: ['modiin', 'rishon'],
      areas: { modiin: ['עמק איילון'] },
    });

    expect(withinAreas(listing({ city: 'ראשון לציון', address: 'רוטשילד 5' }), s)).toBe(true);
    expect(withinAreas(listing({ address: 'נחל צין 3' }), s)).toBe(false);
    expect(withinAreas(listing({ address: 'עמק איילון 9' }), s)).toBe(true);
  });

  it('ignores areas for a city the search does not cover', () => {
    const s = search({ cityKeys: ['modiin'], areas: { rishon: ['רוטשילד'] } });
    expect(withinAreas(listing({ address: 'נחל צין 3' }), s)).toBe(true);
  });

  /**
   * The live failure: a "צפון ראשון" search silently dropped every Realta
   * listing in נוה הדרים, because the alias expands to "נווה הדרים" and the
   * two spellings did not compare equal.
   */
  it('matches a neighbourhood the source spells with fewer letters', () => {
    const s = search({ cityKeys: ['rishon'], areas: { rishon: ['צפון ראשון'] } });
    const inNeveHadarim = listing({ city: 'ראשון לציון', neighborhood: 'נוה הדרים' });

    expect(withinAreas(inNeveHadarim, s)).toBe(true);
  });

  it('still keeps a neighbourhood outside the region out', () => {
    const s = search({ cityKeys: ['rishon'], areas: { rishon: ['צפון ראשון'] } });
    const inRambam = listing({ city: 'ראשון לציון', neighborhood: 'רמב"ם' });

    expect(withinAreas(inRambam, s)).toBe(false);
  });
});

describe('area suggestions from what has actually been advertised', () => {
  let db: Db;
  let listings: ListingsRepo;

  const record = (city: string, neighborhood: string, id: string) =>
    listings.seedAsSeen([listing({ sourceId: id, city, neighborhood })], searchId, 1);

  let searchId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    listings = new ListingsRepo(db);
    searchId = new SearchesRepo(db).create({
      chatId: 1,
      name: 't',
      cityKeys: ['modiin'],
      cityName: 'מודיעין מכבים רעות',
      minRooms: null,
      maxRooms: null,
      minPrice: null,
      maxPrice: null,
    }).id;
  });

  it('offers the neighbourhoods seen in that city, commonest first', () => {
    record('מודיעין מכבים רעות', 'בוכמן', '1');
    record('מודיעין מכבים רעות', 'בוכמן', '2');
    record('מודיעין מכבים רעות', 'הכרמים', '3');

    expect(listings.knownAreas('מודיעין מכבים רעות')).toEqual(['בוכמן', 'הכרמים']);
  });

  it('does not offer another city’s neighbourhoods', () => {
    record('ראשון לציון', 'רביבים', '1');
    expect(listings.knownAreas('מודיעין מכבים רעות')).toEqual([]);
  });

  it('collapses spelling variants and keeps the commonest form', () => {
    record('ראשון לציון', 'רמב"ם', '1');
    record('ראשון לציון', 'רמב"ם', '2');
    record('ראשון לציון', "רמב''ם", '3');

    expect(listings.knownAreas('ראשון לציון')).toEqual(['רמב"ם']);
  });

  it('ignores a source that repeats the city as the neighbourhood', () => {
    record('ראשון לציון', 'ראשון לציון', '1');
    expect(listings.knownAreas('ראשון לציון')).toEqual([]);
  });

  it('caps how many it offers, so the keyboard stays usable', () => {
    // Deliberately not "שכונה 1", "שכונה 2"…: a trailing number is read as a
    // house number and stripped, which would collapse them into one entry.
    const letters = 'אבגדהוזחטיכלמנסעפצקרשת'.split('');
    letters.forEach((letter, i) => record('מודיעין מכבים רעות', `שכונת ${letter}ורן`, `n${i}`));

    expect(listings.knownAreas('מודיעין מכבים רעות').length).toBe(12);
    expect(listings.knownAreas('מודיעין מכבים רעות', 3).length).toBe(3);
  });

  it('treats a trailing number as a house number, not a distinct place', () => {
    record('מודיעין מכבים רעות', 'עמק איילון 4', '1');
    record('מודיעין מכבים רעות', 'עמק איילון 9', '2');

    expect(listings.knownAreas('מודיעין מכבים רעות')).toHaveLength(1);
  });
});

describe('region aliases', () => {
  const north = search({
    cityKeys: ['rishon'],
    cityName: 'ראשון לציון',
    areas: { rishon: ['צפון ראשון'] },
  });

  it('expands a region name to the neighbourhoods sources actually use', () => {
    // "צפון ראשון" is what people say; no board labels a listing that way, so
    // a search using it matched nothing for two weeks.
    const expanded = expandArea('rishon', 'צפון ראשון');
    expect(expanded).toContain('נווה חוף');
    expect(expanded).toContain('מישור הנוף');
    expect(expanded.length).toBeGreaterThan(3);
  });

  it('returns a plain street or neighbourhood unchanged', () => {
    expect(expandArea('rishon', 'רמז')).toEqual(['רמז']);
    // An alias belongs to its city; the same words elsewhere are just words.
    expect(expandArea('modiin', 'צפון ראשון')).toEqual(['צפון ראשון']);
  });

  it('matches a listing in a north-Rishon neighbourhood to a search for צפון ראשון', () => {
    expect(withinAreas(listing({ city: 'ראשון לציון', neighborhood: 'נווה חוף' }), north)).toBe(true);
    expect(withinAreas(listing({ city: 'ראשון לציון', address: 'מישור הנוף 12' }), north)).toBe(true);
  });

  it('still rejects a listing elsewhere in Rishon', () => {
    expect(withinAreas(listing({ city: 'ראשון לציון', neighborhood: 'רמב"ם' }), north)).toBe(false);
  });

  it('still matches nothing for a name nobody uses, which is why the wizard must warn', () => {
    const nowhere = search({
      cityKeys: ['rishon'],
      cityName: 'ראשון לציון',
      areas: { rishon: ['אזור שלא קיים'] },
    });
    expect(withinAreas(listing({ city: 'ראשון לציון', neighborhood: 'רמז' }), nowhere)).toBe(false);
  });
});

describe('known area names', () => {
  it('recognises a region alias', () => {
    expect(isKnownAreaName('rishon', 'צפון ראשון', [])).toBe(true);
  });

  it('recognises a spelling variant of a neighbourhood already seen in listings', () => {
    expect(isKnownAreaName('rishon', 'רמב"ם', ["רמב''ם", 'רמז'])).toBe(true);
    expect(isKnownAreaName('rishon', 'רחוב הרצל 5', ['הרצל'])).toBe(true);
  });

  it('flags a name that nothing has ever matched', () => {
    expect(isKnownAreaName('rishon', 'צפון העיר', ['רמז', 'רמב"ם'])).toBe(false);
    expect(isKnownAreaName('rishon', '', ['רמז'])).toBe(false);
  });
});
