/** Prints the Facebook groups the logged-in profile has joined: `npx tsx scripts/fb-list-groups.ts`. */
import { openContext } from '../src/sources/facebook/fbBrowser.js';

const context = await openContext(true);
const page = await context.newPage();
await page.goto('https://www.facebook.com/groups/joins/?nav_source=tab', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
// Scroll until three rounds in a row load no new group links.
for (let count = 0, idle = 0; idle < 3; ) {
  await page.mouse.wheel(0, 2500);
  await page.waitForTimeout(1500 + Math.random() * 1000);
  const now = await page.locator('a[href*="/groups/"]').count();
  idle = now === count ? idle + 1 : 0;
  count = now;
}
const groups = await page.$$eval('a[href*="/groups/"]', (links) =>
  links.map((a) => ({ href: (a as HTMLAnchorElement).href, name: a.textContent?.trim() ?? '' })),
);
const seen = new Map<string, string>();
for (const { href, name } of groups) {
  const slug = href.match(/\/groups\/([^/?#]+)/)?.[1];
  if (!slug || ['joins', 'feed', 'discover', 'create'].includes(slug) || !name) continue;
  if (!seen.has(slug) || name.length > seen.get(slug)!.length) seen.set(slug, name);
}
if (seen.size === 0) console.log('No groups found - logged out? URL:', page.url());
for (const [slug, name] of seen) console.log(`${slug}\t${name.slice(0, 80)}`);
await context.close();
