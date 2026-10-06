import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { findCityByKey } from '../src/core/cities.js';
import { SessionExpiredError } from '../src/core/types.js';
import type { SavedSearch } from '../src/core/types.js';
import { createFacebookAdapter, toListing } from '../src/sources/facebook/fbAdapter.js';
import { postLink, postText } from '../src/sources/facebook/fbBrowser.js';
import { parsedPostSchema } from '../src/llm/extractPosts.js';
import { FACEBOOK_GROUPS, ROTATING_GROUPS, groupsForCity, groupsToRead } from '../src/sources/facebook/fbGroups.js';
import {
  isPlausibleRent,
  itemDetailsText,
  marketplaceUrl,
  parseMarketplaceCard,
} from '../src/sources/facebook/fbMarketplace.js';
import { createMarketplaceAdapter } from '../src/sources/facebook/marketplaceAdapter.js';
import { buildAdapters } from '../src/sources/index.js';

const search = {} as SavedSearch;
const nobodyKnown = { find: () => undefined };

describe('facebook configuration', () => {
  it('is off by default, whatever profile directory exists', () => {
    // A profile directory is not proof of a session; only the flag is.
    expect(config.facebookEnabled).toBe(false);
  });

  it('has a group list per city, with Modi’in preset', () => {
    expect(groupsForCity(findCityByKey('modiin')!).length).toBeGreaterThan(0);
    expect(groupsForCity(findCityByKey('haifa')!)).toEqual([]);
  });

  it('reads every fixed group each run and rotates through the rest', () => {
    const telAviv = findCityByKey('tel-aviv')!;
    const fixed = FACEBOOK_GROUPS['tel-aviv']!;
    const rotating = ROTATING_GROUPS['tel-aviv']!;
    const seen = new Set<string>();
    for (let run = 0; run < Math.ceil(rotating.length / 12); run++) {
      const groups = groupsToRead(telAviv);
      expect(groups.slice(0, fixed.length)).toEqual(fixed);
      groups.slice(fixed.length).forEach((g) => seen.add(g));
    }
    expect(seen.size).toBe(rotating.length);
  });

  it('builds an adapter that stays off without a key and a session', () => {
    const adapter = createFacebookAdapter(nobodyKnown);
    expect(adapter.name).toBe('facebook');
    expect(adapter.supports(search, findCityByKey('modiin')!)).toBe(false);
  });
});

describe('facebook group posts', () => {
  it('keys a post by its permalink', () => {
    expect(
      postLink(
        [
          'https://www.facebook.com/groups/42/user/7/?__cft__[0]=x',
          'https://www.facebook.com/groups/42/posts/123/?__cft__[0]=x',
        ],
        '42',
      ),
    ).toEqual({ postId: '123', url: 'https://www.facebook.com/groups/42/posts/123/' });
  });

  it('falls back to the post id in photo links, then to a wrapped Marketplace item', () => {
    expect(postLink(['https://www.facebook.com/photo/?fbid=9&set=pcb.456&__cft__[0]=x'], '42')).toEqual({
      postId: '456',
      url: 'https://www.facebook.com/groups/42/posts/456/',
    });
    expect(postLink(['https://www.facebook.com/commerce/listing/789/?ref=share_attachment'], '42')?.postId).toBe('789');
    expect(postLink(['https://www.facebook.com/groups/42/?__cft__[0]=x'], '42')).toBeNull();
  });

  it('drops the hidden runs of "Facebook" from the text', () => {
    expect(postText('Facebook\nFacebook Facebook\nדנה  · Follow\nדירת 3 חדרים ביפו')).toBe('דנה · Follow דירת 3 חדרים ביפו');
  });

  it('takes a post in Jaffa as Tel Aviv', () => {
    const parsed = parsedPostSchema.parse({ index: 0, isRentalListing: true, amenities: [], city: 'יפו', price: 6000 });
    const post = { postId: '1', groupSlug: '42', text: 'דירה ביפו', url: 'https://www.facebook.com/groups/42/posts/1/' };
    expect(toListing(post, parsed, findCityByKey('tel-aviv')!)?.price).toBe(6000);
  });
});

describe('facebook marketplace', () => {
  const href = 'https://www.facebook.com/marketplace/item/1129213912966742/?ref=category_feed&tracking=x';

  it('reads price, title and location from a card, keyed by the item id', () => {
    const card = parseMarketplaceCard(href, 'Just listed\n₪12,200\nליד שינקין | 3 חד׳ | חניה\nTel Aviv, Israel');
    expect(card).toEqual({
      itemId: '1129213912966742',
      url: 'https://www.facebook.com/marketplace/item/1129213912966742/',
      price: 12200,
      title: 'ליד שינקין | 3 חד׳ | חניה',
      location: 'Tel Aviv, Israel',
    });
  });

  it('takes the current price of a reduced one', () => {
    expect(parseMarketplaceCard(href, '₪8,500₪9,000\nדירה\nTel Aviv, Israel')?.price).toBe(8500);
  });

  it('skips links that are not items, and cards with no price line', () => {
    expect(parseMarketplaceCard('https://www.facebook.com/marketplace/telaviv/', '₪5,000\nx')).toBeNull();
    expect(parseMarketplaceCard(href, 'Sponsored')).toBeNull();
  });

  it('opens only prices that could be a month of rent', () => {
    expect(isPlausibleRent(7_000)).toBe(true);
    expect(isPlausibleRent(null)).toBe(true);
    expect(isPlausibleRent(600)).toBe(false); // parking
    expect(isPlausibleRent(4_150_000)).toBe(false); // sale
  });

  it('cuts an item page down to the listing itself', () => {
    const page = [
      'Marketplace', 'Categories', 'Property Rentals',
      'דירה 3 חדרים', '₪7,000 / Month', 'Rental Location', 'תל אביב - יפו', 'Description',
      'דירה מוארת בפלורנטין [hidden information]', ' See more',
      'Seller information', 'Today\'s picks', '₪15', 'סנסיוורה',
    ].join('\n');
    const text = itemDetailsText(page, 'דירה 3 חדרים');
    expect(text.startsWith('דירה 3 חדרים')).toBe(true);
    expect(text).toContain('פלורנטין');
    expect(text).not.toMatch(/Categories|hidden information|See more|Seller|סנסיוורה/);
  });

  it('is configured for Tel Aviv only, newest first', () => {
    expect(marketplaceUrl(findCityByKey('tel-aviv')!)).toContain('/marketplace/telaviv/propertyrentals?sortBy=creation_time_descend');
    expect(marketplaceUrl(findCityByKey('modiin')!)).toBeNull();
  });

  it('stays off without a key and a session, and never polls faster than half-hourly', () => {
    const adapter = createMarketplaceAdapter(nobodyKnown);
    expect(adapter.supports(search, findCityByKey('tel-aviv')!)).toBe(false);
    expect(adapter.cadenceMinutes).toBeGreaterThanOrEqual(30);
  });
});

describe('adapter registry', () => {
  it('registers every source once, facebook last', () => {
    const names = buildAdapters(nobodyKnown).map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toBe('yad2');
    expect(names.at(-1)).toBe('facebook');
  });
});

describe('session expiry', () => {
  it('carries the source and the way to recover', () => {
    const error = new SessionExpiredError('facebook', 'npm run fb-login');
    expect(error.source).toBe('facebook');
    expect(error.message).toContain('npm run fb-login');
    expect(error).toBeInstanceOf(Error);
  });
});
