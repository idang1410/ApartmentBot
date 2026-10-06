import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { logger } from '../../logger.js';
import { randomBetween, sleep } from '../../util/http.js';

/** Session cookies live here so the owner only logs in once. */
export const USER_DATA_DIR = './.fb-profile';

export interface RawPost {
  /** Facebook's own post id, taken from the permalink; the dedupe key. */
  postId: string;
  groupSlug: string;
  text: string;
  url: string;
  /** The "15 באוגוסט ב-22:14" style stamp, as written. */
  postedLabel?: string;
}

/**
 * Drives real installed Chrome (channel: 'chrome') rather than Playwright's
 * bundled Chromium, with a persistent profile.
 *
 * Both details matter: bundled Chromium has a distinctive fingerprint that
 * Facebook flags, and without a persistent profile every run would look like a
 * fresh login from an unknown device, which is what triggers checkpoints.
 */
export async function openContext(headless: boolean): Promise<BrowserContext> {
  // Chrome opens a profile only once and both Facebook sources share this one,
  // so a second caller waits until the first context closes.
  const previous = profileFree;
  let release!: () => void;
  profileFree = new Promise((resolve) => (release = resolve));
  await previous;
  try {
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      channel: 'chrome',
      headless,
      viewport: { width: 1280, height: 900 },
      locale: 'he-IL',
      timezoneId: 'Asia/Jerusalem',
      args: ['--disable-blink-features=AutomationControlled'],
    });
    context.once('close', release);
    return context;
  } catch (error) {
    release();
    throw error;
  }
}

let profileFree: Promise<void> = Promise.resolve();

export class LoggedOutError extends Error {
  constructor() {
    super('Facebook session expired - run `npm run fb-login` to sign in again');
    this.name = 'LoggedOutError';
  }
}

/**
 * Reads the most recent posts from one group.
 *
 * Deliberately slow: it opens the group sorted by newest, waits, scrolls a
 * couple of screens with pauses, and stops. That is roughly what a person
 * checking a group looks like, and it is the main defence against the account
 * being flagged.
 */
export async function readGroupPosts(
  context: BrowserContext,
  groupSlug: string,
  maxPosts: number,
): Promise<RawPost[]> {
  const page = await context.newPage();
  try {
    // sorting_setting=CHRONOLOGICAL puts newest first; the default feed is ranked.
    await page.goto(`https://www.facebook.com/groups/${groupSlug}/?sorting_setting=CHRONOLOGICAL`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await sleep(randomBetween(3_000, 5_000));

    if (await isLoggedOut(page)) throw new LoggedOutError();

    const posts: RawPost[] = [];
    // A few gentle scrolls are enough for a 15-30 minute polling window.
    for (let round = 0; round < 4 && posts.length < maxPosts; round++) {
      // Tagged up front: a locator by position would shift as posts are read.
      const tags = await page.evaluate(
        ([selector, round]) =>
          Array.from(document.querySelectorAll(selector), (el, i) => {
            el.setAttribute('data-apt-read', `${round}-${i}`);
            return `${round}-${i}`;
          }),
        [UNREAD_POST, round] as const,
      );
      for (const tag of tags) {
        if (posts.length >= maxPosts) break;
        // A post Facebook unloads while it is being read is skipped.
        const post = await readPostUnit(page.locator(`[data-apt-read="${tag}"]`), groupSlug).catch(() => null);
        if (post && !posts.some((p) => p.postId === post.postId)) posts.push(post);
      }
      await page.mouse.wheel(0, randomBetween(600, 1_100));
      await sleep(randomBetween(1_500, 3_000));
    }

    logger.debug({ groupSlug, posts: posts.length }, 'read facebook group');
    return posts;
  } finally {
    await page.close();
  }
}

/** A feed post not yet read; read ones are tagged so a later scroll skips them. */
const UNREAD_POST = 'div[role="feed"] > div:not([data-apt-read]):has([data-ad-rendering-role="story_message"])';

/**
 * Reads one post of a group feed.
 *
 * Facebook truncates long posts behind "See more", and fills in the
 * timestamp's permalink only when the pointer reaches it, so both are done
 * by hand before the text and links are read.
 */
async function readPostUnit(unit: Locator, groupSlug: string): Promise<RawPost | null> {
  const seeMore = unit
    .locator('[data-ad-rendering-role="story_message"] [role="button"]')
    .filter({ hasText: /^(See more|ראה עוד|עוד)$/ });
  if ((await seeMore.count()) > 0) {
    await seeMore.first().click({ timeout: 3_000 }).catch(() => undefined);
    await sleep(randomBetween(400, 900));
  }
  // The timestamp is the header's first link that is not a profile.
  await unit.locator('a[href^="?"], a[href="#"]').first().hover({ timeout: 3_000 }).catch(() => undefined);
  await sleep(randomBetween(300, 800));

  const { text, hrefs } = await unit.evaluate((el) => ({
    text: (el as HTMLElement).innerText,
    hrefs: Array.from(el.querySelectorAll('a'), (a) => a.href),
  }));
  const flat = postText(text);
  if (flat.length < 40) return null;
  const link = postLink(hrefs, groupSlug);
  if (!link) return null;

  const postedLabel = /(\d+\s+ב[א-ת]+|לפני\s+\S+|שעה|אתמול)/.exec(flat)?.[0];
  return { ...link, groupSlug, text: flat.slice(0, 2_000), ...(postedLabel ? { postedLabel } : {}) };
}

/** A post's visible text on one line, without the runs of "Facebook" the page hides among it. */
export function postText(innerText: string): string {
  return innerText.replace(/(?:Facebook\s*){2,}/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A group post's id and permalink, from the links inside it: the permalink
 * itself, else the post id photo links carry ("set=pcb.<id>"), else the
 * Marketplace item a sale post wraps.
 */
export function postLink(hrefs: string[], groupSlug: string): { postId: string; url: string } | null {
  for (const href of hrefs) {
    const id = /\/posts\/([\w.]+)/.exec(href)?.[1] ?? /(?:multi_)?permalinks?[/=](\d+)/.exec(href)?.[1];
    if (id) return { postId: id, url: href.split('?')[0] ?? href };
  }
  for (const href of hrefs) {
    const id = /[?&]set=pcb\.(\d+)/.exec(href)?.[1];
    if (id) return { postId: id, url: `https://www.facebook.com/groups/${groupSlug}/posts/${id}/` };
  }
  for (const href of hrefs) {
    const id = /\/commerce\/listing\/(\d+)/.exec(href)?.[1];
    if (id) return { postId: id, url: `https://www.facebook.com/commerce/listing/${id}/` };
  }
  return null;
}

/**
 * Reads the item cards from a Marketplace category page, as (link, text) pairs.
 *
 * Paced like readGroupPosts: one page load, a pause, one scroll.
 */
export async function readMarketplaceCards(
  page: Page,
  url: string,
): Promise<Array<{ href: string; text: string }>> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(randomBetween(3_000, 5_000));

  if (await isLoggedOut(page)) throw new LoggedOutError();

  await page.mouse.wheel(0, randomBetween(600, 1_100));
  await sleep(randomBetween(1_500, 3_000));

  return page.$$eval('a[href*="/marketplace/item/"]', (links) =>
    links.map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a as HTMLElement).innerText })),
  );
}

/** Opens one Marketplace item and returns the page's visible text. */
export async function readMarketplaceItem(page: Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(randomBetween(3_000, 6_000));

  if (await isLoggedOut(page)) throw new LoggedOutError();

  await page.mouse.wheel(0, randomBetween(300, 700));
  await sleep(randomBetween(1_000, 2_500));
  return page.evaluate(() => document.body.innerText);
}

/** True when Facebook is showing a login form instead of the feed. */
export async function isLoggedOut(page: import('playwright').Page): Promise<boolean> {
  return page.evaluate(
    () =>
      Boolean(document.querySelector('input[name="email"]')) ||
      /log into facebook|התחברות לפייסבוק/i.test(document.title),
  );
}
