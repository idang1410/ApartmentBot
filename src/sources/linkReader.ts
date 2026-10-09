import type { Listing } from '../core/types.js';
import { htmlToText } from '../llm/extractListings.js';
import { extractPosts } from '../llm/extractPosts.js';
import { logger } from '../logger.js';
import { fetchText } from '../util/http.js';
import { hasLoginProfile, toListing } from './facebook/fbAdapter.js';
import { openContext, postLink, readMarketplaceItem, readPost } from './facebook/fbBrowser.js';
import { itemDetailsText } from './facebook/fbMarketplace.js';
import { fetchItem } from './yad2/yad2Adapter.js';
import { parseYad2ItemBody } from './yad2/yad2Normalize.js';

/** A listing link the owner sent, with the source and id it is stored under. */
export interface LinkTarget {
  /** How the page is read: through the Facebook profile, or fetched as plain HTML. */
  kind: 'facebook-post' | 'marketplace' | 'page';
  source: string;
  sourceId: string;
  url: string;
  /** Shown on the card, like the boards' own originalSource. */
  label: string;
}

/** What reading a link produced; `rental` is null when the text could not be parsed. */
export interface LinkedListing {
  listing: Listing;
  rental: boolean | null;
}

/** The link a message consists of, or null when the message says anything else. */
export function messageLink(text: string): string | null {
  return /^\s*(https?:\/\/\S+)\s*$/i.exec(text)?.[1] ?? null;
}

/**
 * The source and id a link is stored under. Facebook group posts, Marketplace
 * items, Yad2 and Madlan get the same keys their adapters use, so a flat the
 * bot already read is recognised; any other page is keyed by its host and URL.
 */
export function classifyLink(raw: string): LinkTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  const host = url.hostname.replace(/^(www|m|web)\./, '');

  if (host === 'facebook.com') {
    const item = /^\/marketplace\/item\/(\d+)/.exec(url.pathname)?.[1];
    if (item) {
      const itemUrl = `https://www.facebook.com/marketplace/item/${item}/`;
      return { kind: 'marketplace', source: 'facebook-marketplace', sourceId: item, url: itemUrl, label: 'פייסבוק מרקטפלייס' };
    }
    const group = /^\/groups\/([^/]+)/.exec(url.pathname)?.[1];
    const post = group ? postLink([url.href], group) : null;
    if (group && post) {
      const postUrl = `https://www.facebook.com/groups/${group}/posts/${post.postId}/`;
      return { kind: 'facebook-post', source: 'facebook', sourceId: post.postId, url: postUrl, label: 'קבוצת פייסבוק' };
    }
  }
  if (host === 'yad2.co.il') {
    const token = /^\/realestate\/item\/(?:[^/]+\/)*([a-z0-9]+)\/?$/i.exec(url.pathname)?.[1];
    if (token) {
      return { kind: 'page', source: 'yad2', sourceId: token, url: `https://www.yad2.co.il/realestate/item/${token}`, label: 'יד2' };
    }
  }
  if (host === 'madlan.co.il') {
    const id = /^\/listings\/([^/]+)/.exec(url.pathname)?.[1];
    if (id) {
      const sourceId = decodeURIComponent(id);
      const listingUrl = `https://www.madlan.co.il/listings/${encodeURIComponent(sourceId)}`;
      return { kind: 'page', source: 'madlan', sourceId, url: listingUrl, label: 'מדלן' };
    }
  }
  return { kind: 'page', source: host, sourceId: url.href, url: url.href, label: host };
}

/**
 * Reads a linked listing and turns it into a Listing through the same model
 * extraction as group posts. A page the model judges is not a rental offer is
 * kept as parsed; a page that cannot be read or parsed becomes a bare listing
 * of the link, so it can still be tracked. A Yad2 ad is read from the gateway,
 * with no model.
 */
export async function readLink(target: LinkTarget, cityHint: string): Promise<LinkedListing> {
  if (target.source === 'yad2') {
    try {
      const item = parseYad2ItemBody(await fetchItem(target.sourceId), cityHint);
      if (item) return item;
    } catch (error) {
      logger.warn({ err: error, source: target.source }, 'link read failed');
    }
    return { listing: bareListing(target, cityHint), rental: null };
  }
  let text = '';
  try {
    text = await linkText(target);
  } catch (error) {
    logger.warn({ err: error, source: target.source }, 'link read failed');
  }
  const parsed = text
    ? (await extractPosts([{ id: target.sourceId, text }], cityHint, 'link')).get(target.sourceId)
    : undefined;
  if (!parsed) return { listing: bareListing(target, cityHint), rental: null };

  // Read as an offer whatever the verdict, and in the city the post names.
  const listing = toListing(
    { postId: target.sourceId, groupSlug: '', text, url: target.url },
    { ...parsed, isRentalListing: true, isWantedPost: false },
    { key: '', name: parsed.city ?? cityHint, aliases: [] },
    target.source,
    target.label,
  );
  return {
    listing: listing ?? bareListing(target, cityHint),
    rental: parsed.isRentalListing && !parsed.isWantedPost,
  };
}

/** A listing that holds only the link. */
export function bareListing(target: LinkTarget, city: string): Listing {
  return {
    source: target.source,
    sourceId: target.sourceId,
    url: target.url,
    price: null,
    rooms: null,
    city,
    amenities: [],
    imageUrls: [],
    originalSource: target.label,
  };
}

/** The page's text; Facebook pages through the shared profile, which waits its turn. */
async function linkText(target: LinkTarget): Promise<string> {
  if (target.kind === 'page') {
    return htmlToText(await fetchText(target.url, { source: target.source, retries: 0 }));
  }
  if (!hasLoginProfile()) throw new Error('facebook is not enabled');
  const context = await openContext(true);
  try {
    if (target.kind === 'facebook-post') return await readPost(context, target.url);
    return itemDetailsText((await readMarketplaceItem(await context.newPage(), target.url)).text, '');
  } finally {
    await context.close();
  }
}
