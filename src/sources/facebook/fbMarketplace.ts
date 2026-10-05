import type { CityEntry } from '../../core/types.js';

/**
 * Marketplace location slug per city key - the segment in
 * facebook.com/marketplace/<slug>/propertyrentals. A city without one is not read.
 */
export const MARKETPLACE_LOCATIONS: Record<string, string> = {
  'tel-aviv': 'telaviv',
};

export function marketplaceUrl(city: CityEntry): string | null {
  const slug = MARKETPLACE_LOCATIONS[city.key];
  // creation_time_descend puts the newest listings first; the default order is ranked.
  return slug
    ? `https://www.facebook.com/marketplace/${slug}/propertyrentals?sortBy=creation_time_descend&exact=false`
    : null;
}

export interface MarketplaceCard {
  /** Marketplace's own item id, from /marketplace/item/<id>/; the dedupe key. */
  itemId: string;
  url: string;
  price: number | null;
  title: string;
  location: string;
}

/**
 * Reads a listing card's text: an optional badge ("Just listed"), the price,
 * the title and the location, one per line. A card shows a reduced price as
 * two prices run together; the first is the current one.
 */
export function parseMarketplaceCard(href: string, text: string): MarketplaceCard | null {
  const itemId = /\/marketplace\/item\/(\d+)/.exec(href)?.[1];
  if (!itemId) return null;

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const priceAt = lines.findIndex((line) => /₪|ILS|free|חינם/i.test(line));
  if (priceAt === -1) return null;

  const digits = /\d[\d,]*/.exec(lines[priceAt]!)?.[0]?.replace(/,/g, '');
  return {
    itemId,
    url: `https://www.facebook.com/marketplace/item/${itemId}/`,
    price: digits ? Number(digits) : null,
    title: lines[priceAt + 1] ?? '',
    location: lines[priceAt + 2] ?? '',
  };
}

/**
 * Whether a card's price could be a month's rent. The rentals category also
 * carries sales, parking spots and storage; opening those would spend the
 * per-visit budget of item pages on ads that are never flats to rent.
 */
export function isPlausibleRent(price: number | null): boolean {
  return price === null || (price >= 1_000 && price <= 100_000);
}

/**
 * The listing part of an item page's text: from the title to the seller
 * block, without the navigation above it or the suggestions below.
 */
export function itemDetailsText(pageText: string, title: string): string {
  const start = title ? pageText.indexOf(title) : -1;
  const body = start === -1 ? pageText : pageText.slice(start);
  const end = body.search(/Seller information|פרטי המוכר|Today's picks/);
  return (end === -1 ? body : body.slice(0, end))
    .replace(/\[hidden information\]|See more|הצג עוד/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
