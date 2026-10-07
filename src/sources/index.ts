import { config } from '../config.js';
import type { SourceAdapter, StoredListings } from '../core/types.js';
import type { KvRepo } from '../db/kv.repo.js';
import { createFacebookAdapter } from './facebook/fbAdapter.js';
import { createMarketplaceAdapter } from './facebook/marketplaceAdapter.js';
import { createGenericAdapter } from './generic/genericAdapter.js';
import { GENERIC_CADENCE_MINUTES, GENERIC_SITES } from './generic/sites.js';
import { homelessAdapter } from './homeless/homelessAdapter.js';
import { madlanAdapter } from './madlan/madlanAdapter.js';
import { onmapAdapter } from './onmap/onmapAdapter.js';
import { realtaAdapter } from './realta/realtaAdapter.js';
import { createTelegramAdapter } from './telegram/telegramAdapter.js';
import { createYad2Adapter } from './yad2/yad2Adapter.js';

/**
 * Sources come in three kinds.
 *
 * **Native parsers** read data that is already structured, so they are cheap,
 * exact and run every cycle:
 *  - yad2     - the largest board. Its website is unreachable behind Radware,
 *               but the gateway's paged feed is open; it is read from the top
 *               until a page holds nothing new, and posting dates are
 *               recovered from the photo URLs.
 *  - realta   - aggregates Yad2, Madlan, OnMap, Komo and Facebook Marketplace,
 *               and is the only source publishing a real date on every listing.
 *  - homeless - mobile site, plain server-rendered HTML.
 *  - onmap    - public JSON API; no Modi'in inventory today, but cheap to ask.
 *  - madlan   - its own GraphQL API. The site and `/api2` are behind
 *               PerimeterX, but `/api3` is not; it has no city filter, so it
 *               is asked for the newest listings in the country and the city
 *               is matched afterwards.
 *
 * **Model-extracted sources** cover the long tail of Israeli boards that have
 * no API: fetch the page, hand the text to Gemini, get listings back. Adding
 * one is a URL in sites.ts, and a site redesign degrades quality instead of
 * silently breaking a scraper. They run hourly.
 *
 * **Free-text posts** - public Telegram channels through their web preview,
 * and Facebook groups and Marketplace through the owner's own logged-in session
 * (inert unless FACEBOOK_ENABLED is set after a successful login). All ask the store
 * whether a post was already read, so feeds repeating the same posts for
 * days cost no model calls.
 *
 * Which of these actually run is the SOURCES setting; unset means all of them.
 * Cross-source fingerprinting means a flat that Realta re-publishes from Yad2
 * or Madlan is still only alerted once, whichever combination is switched on.
 */
export function buildAdapters(
  stored: StoredListings,
  enabled: string[] | undefined = config.enabledSources,
  kv?: KvRepo,
): SourceAdapter[] {
  const genericAdapters = GENERIC_SITES.map((site) =>
    createGenericAdapter(site, GENERIC_CADENCE_MINUTES),
  );

  const all = [
    createYad2Adapter(undefined, kv),
    realtaAdapter,
    homelessAdapter,
    onmapAdapter,
    madlanAdapter,
    ...genericAdapters,
    createTelegramAdapter(stored),
    createMarketplaceAdapter(stored),
    createFacebookAdapter(stored),
  ];

  // An empty or absent list means "everything". A blank SOURCES= in .env must
  // not silently mute the bot - the only way to run nothing is to name nothing
  // that exists, which is a typo worth noticing rather than a supported state.
  if (!enabled || enabled.length === 0) return all;
  return all.filter((adapter) => enabled.includes(adapter.name));
}

// Parsing SOURCES lives in config.ts, which must not import the adapters -
// they import it. Re-exported here so the setting and the sources it selects
// read as one thing.
export { selectSources } from '../config.js';
