import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
import { listingCityMatches } from '../../core/cities.js';
import {
  SessionExpiredError,
  type CityEntry,
  type DeepStep,
  type Listing,
  type SavedSearch,
  type SourceAdapter,
  type StoredListings,
} from '../../core/types.js';
import { extractPosts, type ParsedPost } from '../../llm/extractPosts.js';
import { isGeminiConfigured, redactPhones } from '../../llm/gemini.js';
import { logger } from '../../logger.js';
import { randomBetween, sleep } from '../../util/http.js';
import { parseEntryDate, parsePostedDate } from '../../util/time.js';
import { ParsedPostCache } from '../parsedPostCache.js';
import { LoggedOutError, openContext, readGroupPosts, USER_DATA_DIR, type RawPost } from './fbBrowser.js';
import { FACEBOOK_GROUPS, groupsForCity, groupsToRead } from './fbGroups.js';

const SOURCE = 'facebook';
const POSTS_PER_GROUP = 30;
/** A deep-search group visit reads back this far, up to DEEP_POSTS_PER_GROUP posts. */
const DEEP_MAX_AGE_DAYS = 14;
const DEEP_POSTS_PER_GROUP = 150;
/** Enough scrolls for DEEP_POSTS_PER_GROUP posts. */
const DEEP_MAX_SCROLLS = 100;
/** Posts the model has already judged are not sent again for a day. */
const PARSED_TTL_MS = 24 * 60 * 60 * 1000;
export const LOGIN_INSTRUCTION = 'npm run fb-login';

/**
 * Reads the owner's Facebook groups and turns free-text posts into listings.
 *
 * This is where the private, no-broker flats appear first - they are posted to
 * groups hours before they reach the listing boards, if they ever do. It is
 * also the most fragile source: it needs a logged-in session, Facebook changes
 * its markup often, and polling too eagerly risks the account. Hence the slow
 * cadence and the small number of posts per visit.
 *
 * Model calls are the other budget. A post already recorded is handed back
 * from the store; a post already judged this day is skipped; only the rest
 * are sent, ten to a call.
 */
export function createFacebookAdapter(stored: StoredListings): SourceAdapter {
  const judged = new ParsedPostCache(PARSED_TTL_MS);

  return {
    name: SOURCE,
    // Twice an hour whatever the poll interval is. Reading groups is the
    // riskiest thing the bot does, so a shorter POLL_MINUTES must not speed it up.
    cadenceMinutes: 30,

    supports(_search: SavedSearch, city: CityEntry): boolean {
      // Needs groups for the city, a key to read their posts with, and a signed-in
      // profile. Checking the profile here avoids launching Chrome - nearly a
      // minute per cycle - only to discover there is no session to use.
      return isGeminiConfigured() && hasLoginProfile() && groupsForCity(city).length > 0;
    },

    async fetchListings(_search: SavedSearch, city: CityEntry): Promise<Listing[]> {
      const groups = groupsToRead(city);
      if (groups.length === 0) return [];

      const posts = await readGroups(
        groups,
        (post) => stored.find(SOURCE, post.postId) !== undefined || judged.has(SOURCE, post.postId),
      );
      return toListings(posts, city);
    },

    /** One fixed area group per step, read back DEEP_MAX_AGE_DAYS. Rotating groups have no deep search. */
    async deepSearch(city: CityEntry, from: number): Promise<DeepStep> {
      const groups = FACEBOOK_GROUPS[city.key] ?? [];
      const group = groups[from];
      if (!group) return { listings: [], next: null, total: groups.length };

      const cutoff = Date.now() - DEEP_MAX_AGE_DAYS * 86_400_000;
      const isOld = (post: RawPost) => (parsePostedDate(post.postedLabel)?.getTime() ?? Infinity) < cutoff;
      let posts: RawPost[] = [];
      const context = await openContext(true);
      try {
        posts = await readGroupPosts(context, group, DEEP_POSTS_PER_GROUP, isOld, DEEP_MAX_SCROLLS);
      } catch (error) {
        if (error instanceof LoggedOutError) throw new SessionExpiredError(SOURCE, LOGIN_INSTRUCTION);
        // Offline, the step is tried again; a group that cannot be read is passed over.
        if (isOffline(error)) throw error;
        logger.warn({ err: error, group }, 'facebook deep group read failed');
      } finally {
        await context.close();
      }
      const next = from + 1 < groups.length ? from + 1 : null;
      return { listings: await toListings(posts.filter((p) => !isOld(p)), city), next, total: groups.length };
    },
  };

  /** Posts as listings: recorded ones from the store, the rest not judged today through the model. */
  async function toListings(posts: RawPost[], city: CityEntry): Promise<Listing[]> {
    const listings: Listing[] = [];
    const unjudged: RawPost[] = [];
    for (const post of posts) {
      const known = stored.find(SOURCE, post.postId);
      if (known) {
        listings.push(known);
        continue;
      }
      if (!judged.has(SOURCE, post.postId)) unjudged.push(post);
    }

    const parsed = await extractPosts(
      unjudged.map((post) => ({ id: post.postId, text: post.text })),
      city.name,
      SOURCE,
    );

    for (const post of unjudged) {
      const result = parsed.get(post.postId);
      // A post the model did not answer for is left for next time.
      if (!result) continue;
      judged.add(SOURCE, post.postId);
      const listing = toListing(post, result, city);
      if (listing) listings.push(listing);
    }

    logger.debug(
      { city: city.key, posts: posts.length, sentToModel: unjudged.length, listings: listings.length },
      'facebook fetch complete',
    );
    return listings;
  }
}

/** True for a page load that failed because the machine has no network, which fails every page alike. */
export function isOffline(error: unknown): boolean {
  return (
    error instanceof Error &&
    /net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE)/.test(error.message)
  );
}

async function readGroups(groups: string[], isKnown: (post: RawPost) => boolean): Promise<RawPost[]> {
  const context = await openContext(true);
  const posts: RawPost[] = [];

  try {
    for (const group of groups) {
      try {
        posts.push(...(await readGroupPosts(context, group, POSTS_PER_GROUP, isKnown)));
      } catch (error) {
        // An expired login fails every group the same way. Stop at the first
        // and say so - knocking on each door and reporting nothing is what
        // hid an expired session for weeks.
        if (error instanceof LoggedOutError) {
          throw new SessionExpiredError(SOURCE, LOGIN_INSTRUCTION);
        }
        // Offline, the rest would fail too; stop and keep what was read.
        if (isOffline(error)) {
          logger.warn({ group }, 'facebook groups stopped: no network');
          break;
        }
        // A single unreachable group must not lose the others.
        logger.warn({ err: error, group }, 'facebook group read failed');
      }
      await sleep(randomBetween(4_000, 9_000));
    }
  } finally {
    await context.close();
  }

  return posts;
}

/**
 * Facebook stays off unless explicitly switched on.
 *
 * A profile directory is not proof of a usable session - merely launching the
 * browser creates one - so an expired login had the bot opening Chrome and
 * failing on every group, every cycle. An explicit flag makes the state
 * unambiguous: set FACEBOOK_ENABLED=1 after `npm run fb-login` succeeds.
 */
export function hasLoginProfile(): boolean {
  if (!config.facebookEnabled) return false;
  return existsSync(join(USER_DATA_DIR, 'Default'));
}

export function toListing(
  post: RawPost,
  parsed: ParsedPost,
  city: CityEntry,
  source = SOURCE,
  originalSource = 'קבוצת פייסבוק',
): Listing | null {
  if (!parsed.isRentalListing || parsed.isWantedPost) return null;

  // Posts often omit the city because the group implies it; assume the
  // group's city, but reject a post that names a different one.
  if (parsed.city && !listingCityMatches(city, parsed.city)) return null;

  // Phone numbers never left the machine; they are re-attached here from the
  // original text so the owner can still make the call. The first becomes
  // the WhatsApp button; any others stay in the text.
  const [phone, ...morePhones] = redactPhones(post.text).phones;
  const description = [parsed.summary, morePhones.length > 0 ? `📞 ${morePhones.join(' · ')}` : null]
    .filter(Boolean)
    .join('\n');

  const postedAt = parsePostedDate(post.postedLabel);
  const entryDate = parseEntryDate(parsed.entryDateText);

  return {
    source,
    sourceId: post.postId,
    url: post.url,
    price: parsed.price,
    rooms: parsed.rooms,
    city: parsed.city ?? city.name,
    ...(parsed.neighborhood ? { neighborhood: parsed.neighborhood } : {}),
    ...(parsed.street ? { address: parsed.street } : {}),
    ...(parsed.propertyType ? { propertyType: parsed.propertyType } : {}),
    ...(parsed.sqm ? { sqm: parsed.sqm } : {}),
    ...(parsed.floor ? { floor: parsed.floor } : {}),
    amenities: parsed.amenities,
    ...(description ? { description } : {}),
    imageUrls: post.imageUrls ?? [],
    ...(postedAt ? { postedAt } : {}),
    ...(parsed.entryDateText ? { entryText: parsed.entryDateText } : {}),
    ...(entryDate ? { entryDate } : {}),
    ...(phone ? { phone } : {}),
    originalSource,
    ...(parsed.isBroker !== null ? { isBroker: parsed.isBroker } : {}),
  };
}
