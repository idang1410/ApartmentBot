import { describe, expect, it } from 'vitest';
import { formatCopies, formatListing } from '../src/bot/format.js';
import { sameFlat, type Listing } from '../src/core/types.js';
import { openDatabase } from '../src/db/database.js';
import { ListingsRepo } from '../src/db/listings.repo.js';

const CHAT = 7;

function ad(overrides: Partial<Listing> = {}): Listing {
  return {
    source: 'yad2',
    sourceId: 'agent',
    url: 'https://www.yad2.co.il/realestate/item/agent',
    price: 8_400,
    rooms: 3,
    sqm: 80,
    floor: 'קומה 3',
    city: 'תל אביב יפו',
    address: 'השוק 37',
    isBroker: true,
    amenities: [],
    imageUrls: [],
    ...overrides,
  };
}

const agent = ad();
const owner = ad({ sourceId: 'owner', url: 'https://www.yad2.co.il/realestate/item/owner', price: 8_600, isBroker: false });
const onmap = ad({
  source: 'onmap',
  sourceId: 'o1',
  url: 'https://www.onmap.co.il/property/o1',
  price: 8_500,
  address: 'השוק',
  floor: 'קומה 2',
  isBroker: undefined,
});

describe('same flat', () => {
  it('matches one flat listed by an agent and by the owner at different prices', () => {
    expect(sameFlat(agent, owner)).toBe('same');
  });

  it('says maybe for a numberless street on another floor', () => {
    expect(sameFlat(agent, onmap)).toBe('maybe');
  });

  it('rejects another street, another number, another size, or no street', () => {
    expect(sameFlat(agent, ad({ address: 'הרצל 37' }))).toBeNull();
    expect(sameFlat(agent, ad({ address: 'השוק 12' }))).toBeNull();
    expect(sameFlat(agent, ad({ sqm: 90 }))).toBeNull();
    expect(sameFlat(agent, ad({ rooms: 4 }))).toBeNull();
    expect(sameFlat(ad({ address: undefined }), ad({ address: undefined }))).toBeNull();
  });

  it('needs both sizes to match a numberless street to a numbered one', () => {
    expect(sameFlat(agent, ad({ address: 'השוק', sqm: undefined }))).toBeNull();
    expect(sameFlat(ad({ sqm: 83 }), ad({ address: 'רחוב השוק', floor: '3' }))).toBe('same');
  });
});

describe('copies on the card', () => {
  it('lists each copy with board, broker, price difference and link', () => {
    const lines = formatCopies(agent, [
      { listing: onmap, kind: 'maybe', status: null },
      { listing: owner, kind: 'same', status: 'rejected' },
    ]);
    expect(lines).toEqual([
      '👯 אותה דירה מפורסמת גם ב:',
      '• ❌ · יד2 · פרטי · 8,600 ₪ (+200) · <a href="https://www.yad2.co.il/realestate/item/owner">מודעה</a>',
      '• אולי: onmap · 8,500 ₪ (+100) · קומה 2 · <a href="https://www.onmap.co.il/property/o1">מודעה</a>',
    ]);
  });

  it('shows at most five and keeps them when the description is long', () => {
    const copies = Array.from({ length: 8 }, (_, i) => ({
      listing: ad({ sourceId: `c${i}`, url: `https://www.yad2.co.il/realestate/item/c${i}`, price: 8_000 }),
      kind: 'same' as const,
      status: null,
    }));
    const text = formatListing(ad({ description: 'א'.repeat(5_000) }), undefined, null, copies);
    expect(text).toContain('• יד2 · תיווך · 8,000 ₪ (−400)');
    expect(text.match(/מודעה<\/a>/g)).toHaveLength(5);
    expect(text.length).toBeLessThanOrEqual(1024);
  });
});

describe('copies in the repo', () => {
  it('finds other stored ads of the flat, with their status, but not the ad itself', () => {
    const repo = new ListingsRepo(openDatabase(':memory:'));
    repo.seedAsSeen([agent, onmap, ad({ sourceId: 'x', address: 'הרצל 1' })], 1, CHAT);
    repo.setStatus(repo.track(owner, CHAT), CHAT, 'rejected');

    const copies = repo.copiesOf(agent, CHAT);
    expect(copies.map((c) => [c.listing.sourceId, c.kind, c.status])).toEqual([
      ['owner', 'same', 'rejected'],
      ['o1', 'maybe', null],
    ]);
    expect(repo.copiesOf(agent, CHAT + 1)).toEqual([]);
  });
});
