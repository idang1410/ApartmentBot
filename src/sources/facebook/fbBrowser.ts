import { chromium, type BrowserContext, type Page } from 'playwright';
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

    // Two gentle scrolls are enough for a 15-30 minute polling window.
    for (let i = 0; i < 2; i++) {
      await page.mouse.wheel(0, randomBetween(600, 1_100));
      await sleep(randomBetween(1_500, 3_000));
    }

    const posts = await page.evaluate((limit) => {
      const results: Array<{ postId: string; text: string; url: string; postedLabel?: string }> = [];

      const articles = Array.prototype.slice.call(
        document.querySelectorAll('div[role="article"]'),
      ) as HTMLElement[];

      for (const article of articles) {
        const text = article.innerText?.replace(/\s+/g, ' ').trim() ?? '';
        if (text.length < 40) continue;

        const link = article.querySelector(
          'a[href*="/posts/"], a[href*="permalink"], a[href*="multi_permalinks"]',
        ) as HTMLAnchorElement | null;
        const href = link?.href ?? '';
        const id =
          /\/posts\/([\w.]+)/.exec(href)?.[1] ??
          /(?:multi_)?permalinks?[/=](\d+)/.exec(href)?.[1] ??
          null;
        if (!id) continue;
        if (results.some((r) => r.postId === id)) continue;

        results.push({
          postId: id,
          text: text.slice(0, 2_000),
          url: href.split('?')[0] ?? href,
          ...(/(\d+\s+ב[א-ת]+|לפני\s+\S+|שעה|אתמול)/.exec(text)?.[0]
            ? { postedLabel: /(\d+\s+ב[א-ת]+|לפני\s+\S+|שעה|אתמול)/.exec(text)![0] }
            : {}),
        });
        if (results.length >= limit) break;
      }
      return results;
    }, maxPosts);

    logger.debug({ groupSlug, posts: posts.length }, 'read facebook group');
    return posts.map((p) => ({ ...p, groupSlug }));
  } finally {
    await page.close();
  }
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
