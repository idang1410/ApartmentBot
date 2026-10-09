import {
  SessionExpiredError,
  type CityEntry,
  type DeepStep,
  type Listing,
  type SavedSearch,
  type SourceAdapter,
  type StoredListings,
} from '../../core/types.js';
import { extractPosts } from '../../llm/extractPosts.js';
import { isGeminiConfigured } from '../../llm/gemini.js';
import { logger } from '../../logger.js';
import { randomBetween, sleep } from '../../util/http.js';
import { ParsedPostCache } from '../parsedPostCache.js';
import { hasLoginProfile, isOffline, LOGIN_INSTRUCTION, toListing } from './fbAdapter.js';
import {
  LoggedOutError,
  openContext,
  readMarketplaceCards,
  readMarketplaceItem,
  type RawPost,
} from './fbBrowser.js';
import { isPlausibleRent, itemDetailsText, marketplaceUrl, parseMarketplaceCard } from './fbMarketplace.js';

const SOURCE = 'facebook-marketplace';
/** Item pages opened per visit; the rest wait for the next one. */
const ITEMS_PER_VISIT = 10;
/** Cards a deep-search visit loads; each step opens the next ITEMS_PER_VISIT unread ones. */
const DEEP_CARDS = 200;
/** Steps a deep search takes at most: DEEP_CARDS / ITEMS_PER_VISIT. */
const DEEP_MAX_STEPS = DEEP_CARDS / ITEMS_PER_VISIT;
/** Items the model has already judged are not sent again for a day. */
const PARSED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Reads Facebook Marketplace property rentals through the same logged-in
 * profile as the groups source.
 *
 * A card carries only price, title and location, so each new item's page is
 * opened - at most ITEMS_PER_VISIT, with human-length pauses - and its text
 * goes through the same model extraction as group posts. Items already
 * recorded come back from the store and are never opened again.
 */
export function createMarketplaceAdapter(stored: StoredListings): SourceAdapter {
  const judged = new ParsedPostCache(PARSED_TTL_MS);

  return {
    name: SOURCE,
    // 30-50 minutes, drawn afresh each cycle, so visits do not fall on a fixed beat.
    get cadenceMinutes() {
      return Math.round(randomBetween(30, 50));
    },

    supports(_search: SavedSearch, city: CityEntry): boolean {
      return isGeminiConfigured() && hasLoginProfile() && marketplaceUrl(city) !== null;
    },

    async fetchListings(_search: SavedSearch, city: CityEntry): Promise<Listing[]> {
      return (await visit(city, 0)).listings;
    },

    /** Each step loads up to DEEP_CARDS cards and opens the next unread ones. */
    async deepSearch(city: CityEntry, from: number): Promise<DeepStep> {
      const { listings, unread } = await visit(city, DEEP_CARDS);
      const next = unread > ITEMS_PER_VISIT && from + 1 < DEEP_MAX_STEPS ? from + 1 : null;
      return { listings, next, total: from + Math.ceil(unread / ITEMS_PER_VISIT) };
    },
  };

  /**
   * Loads the category page (at least `minCards` cards), and opens up to ITEMS_PER_VISIT
   * items not read before. `unread` counts the items that were waiting to be opened.
   */
  async function visit(
    city: CityEntry,
    minCards: number,
  ): Promise<{ listings: Listing[]; unread: number }> {
    const url = marketplaceUrl(city);
    if (!url) return { listings: [], unread: 0 };

    const listings: Listing[] = [];
    const posts: RawPost[] = [];
    let unread = 0;
    const context = await openContext(true);
    try {
      const page = await context.newPage();
      const cards = (await readMarketplaceCards(page, url, minCards))
        .map(({ href, text }) => parseMarketplaceCard(href, text))
        .filter((card) => card !== null)
        .filter((card, index, all) => all.findIndex((c) => c.itemId === card.itemId) === index)
        .slice(0, minCards || undefined);

      const unseen = [];
      for (const card of cards) {
        const known = stored.find(SOURCE, card.itemId);
        if (known) listings.push(known);
        else if (judged.has(SOURCE, card.itemId)) continue;
        else if (!isPlausibleRent(card.price)) judged.add(SOURCE, card.itemId);
        else unseen.push(card);
      }

      unread = unseen.length;
      for (const card of unseen.slice(0, ITEMS_PER_VISIT)) {
        await sleep(randomBetween(8_000, 20_000));
        let item: { text: string; imageUrls: string[] };
        try {
          item = await readMarketplaceItem(page, card.url);
        } catch (error) {
          if (error instanceof LoggedOutError) throw error;
          if (isOffline(error)) break;
          // A single unreachable item must not lose the others.
          logger.warn({ err: error, item: card.itemId }, 'facebook marketplace item read failed');
          continue;
        }
        const text = itemDetailsText(item.text, card.title);
        posts.push({
          postId: card.itemId,
          groupSlug: 'marketplace',
          // An item page that yielded nothing still has its card.
          text: text || [card.title, card.price ? `₪${card.price}` : '', card.location].join('\n'),
          url: card.url,
          imageUrls: item.imageUrls,
        });
      }
    } catch (error) {
      if (error instanceof LoggedOutError) throw new SessionExpiredError(SOURCE, LOGIN_INSTRUCTION);
      throw error;
    } finally {
      await context.close();
    }

    const parsed = await extractPosts(
      posts.map((post) => ({ id: post.postId, text: post.text })),
      city.name,
      SOURCE,
    );

    for (const post of posts) {
      const result = parsed.get(post.postId);
      // An item the model did not answer for is left for next time.
      if (!result) continue;
      judged.add(SOURCE, post.postId);
      const listing = toListing(post, result, city, SOURCE, 'פייסבוק מרקטפלייס');
      if (listing) listings.push(listing);
    }

    logger.debug(
      { city: city.key, opened: posts.length, listings: listings.length },
      'facebook marketplace fetch complete',
    );
    return { listings, unread };
  }
}
