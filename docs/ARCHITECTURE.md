# Architecture

Notes for anyone changing the code. The README covers setup and the sources; this covers how
the pieces fit and the rules that keep them working.

## The pipeline

```
Scheduler ──▶ PollCycle ──▶ SourceAdapter[] ──▶ filter ──▶ dedupe ──▶ Notifier ──▶ Telegram
(chained timer,  (per search   (concurrent,      (price,    (seen_listings   (queued, quiet-hour
 ±20% jitter)     × city)       Promise.allSettled) rooms,    per chat)        aware, 8/chat/cycle)
                                                   areas, age)
```

`src/index.ts` wires everything by hand; there is no DI container. The `Bot` is created
before its handlers so `Notifier` can hold `bot.api` while the handlers hold the `PollCycle`
the notifier feeds. Handlers are registered inside `bot.start({ onStart })`, because invite
links need the bot's username and Telegram only reveals it once polling begins.

## Sources

Every source implements `SourceAdapter` (`src/core/types.ts`) and is built by `buildAdapters`
in `src/sources/index.ts`. A source that throws is isolated by `Promise.allSettled`, so it
never aborts a sweep. `cadenceMinutes` (0 means every cycle) is measured on the clock, so a
shorter `POLL_MINUTES` speeds up the cheap sources without touching the slow ones.

- **Native parsers** (`yad2`, `realta`, `homeless`, `onmap`, `madlan`) read data that is
  already structured. Each has an adapter (fetch and orchestrate) and a pure, fixture-backed
  parser.
- **Model-read sites** have no per-site parser. `createGenericAdapter` reduces the page to
  visible text plus candidate links and images, and Gemini returns structured listings.
  Adding one is a URL and a display name in `src/sources/generic/sites.ts`. They run hourly
  and stay off without `GEMINI_API_KEY`.
- **Free-text posts** from public Telegram channels (`t.me/s/<name>`, read with cheerio;
  photos there are `background-image` styles, which is why it has its own parser) and from
  Facebook groups (a real logged-in Chrome profile, off unless `FACEBOOK_ENABLED=1`). Both
  go through `src/llm/extractPosts.ts`, ten posts per model call, and only posts the store
  has not seen are sent at all. An expired Facebook login throws `SessionExpiredError`: one
  message to the owner, then the source backs off.

Model output is validated per item (`src/llm/fields.ts`): a missing field and `null` mean the
same thing, and an impossible value (`rooms: 0`) becomes `null`, so one bad entry never costs
the whole page.

When adding a source, prefer the model-read path. Write a parser only when the site already
publishes structured data, and then add a captured fixture under `test/fixtures/`, so a markup
change fails a test instead of quietly returning nothing. Strip phone numbers and names from
any captured fixture before committing it.

### Yad2

Yad2's website sits behind Radware, but the gateway its pages call is open. The adapter reads
the paged feed (`/realestate-feed/rent/feed`). The old map endpoint returned at most 200 ads
per city, and not the newest ones.

- The feed is ordered by last update, and a bump counts as one. `createYad2Adapter` reads from
  page 1 while pages hold organic ads it has not seen (between `MIN_PAGES` and `MAX_PAGES`).
  The promoted `platinum`/`booster` slots rotate on every request and are ignored for this.
- The tokens recent walks read are kept in `kv` (`yad2_seen:<cityKey>`, the newest 1,000), so a
  restart reads only back to them. Only a poll walk that finishes cleanly saves them. New-search
  seeding passes `{ preview: true }` and walks on a copy. A walk that reaches `MAX_PAGES` without
  meeting a read ad starts the city's Yad2 deep search again.
- Only `region`, `city` and `page` are sent. Any other parameter makes the gateway's firewall
  answer with a small JSON record (which includes the caller's IP) instead of data.
  `detectBlockPage` recognises it, and no raw Yad2 body is ever logged.
- City codes are four digits, zero-padded (`0168`). Sent unpadded, Yad2 returns an empty city.

## Deep search

`DeepSearch` (`src/core/deepSearch.ts`) reads each source's whole catalogue for every watched
city once, so regular scans only read back to what was already seen. A source opts in with
`deepSearch(city, from)`, which reads a few units (pages, or one Facebook group) and returns
where the next step starts. Each poll cycle, after its regular reads, takes one step per
unfinished source and city; no new city starts once the cycle has spent `DEEP_BUDGET_MS` on
them. Progress is `deep:<source>:<cityKey>` in `kv`, so a restart resumes. A failed step is
not counted and goes through `HealthTracker` like a fetch; a source backing off sits it out.

A city with no record starts by itself; `/deep` starts every source over unless one is in
progress. Matches are recorded as seen with their match kind, for `/review`, and never
alerted. Each chat gets one message per source that found something and a summary when every
source of the city is done.

| Source | Step | Cap |
| --- | --- | --- |
| yad2 | 5 pages | `totalPages`, at most 200 |
| realta | 10 pages of 50 | 200 pages |
| onmap | 5 pages of 100 (`$skip`) | 100 pages |
| madlan | 3 nationwide pages of 100, shared by cities for 30 minutes | 30 days old, or 200 pages |
| facebook | one fixed area group (`FACEBOOK_GROUPS`); rotating groups have none | 14 days old, or 150 posts |
| facebook-marketplace | 10 item pages out of the first 200 cards | 20 steps |

The two Facebook sources share one step at most every 15 minutes (`deep_last_facebook` in `kv`).

Homeless, the model-read sites and Telegram have no deep search.

## Nothing is alerted twice

1. **`(chat_id, source, listing_id)` primary key** in `seen_listings`. Seen-ness is per chat:
   a global key once let whoever polled first claim a listing and starved the second user.
2. **`listingFingerprint`** collapses the same flat arriving from different boards. It returns
   `null` unless price, rooms and a size or street are all known: merging two ordinary 3-room
   flats at the same price would drop a real listing, which is worse than a duplicate.
3. **First-sight seeding.** A source's back catalogue is recorded silently the first time it
   is read, and so is the market when a search is created (`seedSearch`). Most boards publish
   no dates, so this is what keeps years-old ads out of the alerts.
4. **`MAX_LISTING_AGE_DAYS = 30`**, applied where a source publishes a date.
5. **Sequence baseline.** Yad2 numbers its ads in creation order (`Listing.sequence`). The
   first time a search reads a city, `PollCycle` stores the highest number per source
   (`seq_baseline:<searchId>:<source>:<cityKey>` in `kv`); anything at or below it is recorded
   silently, however recently it was bumped. Where a search has no baseline yet, the newest
   number seen in any city (`seq_high:<source>`) stands in, so a town's very first ad still
   alerts. Baselines never move.

## Filters

Filters are permissive: an unknown room count, size, type or broker status passes, because a
missing field is usually a parsing gap. Price is the exception. A listing with no price is
dropped, since "מחיר לא צוין" is almost always a broker holding back the figure. Chosen streets
and neighbourhoods are the other exception: a listing with no address cannot match them.
Everyday area names are expanded through `REGION_ALIASES` in `cities.ts` ("צפון ראשון" to its
neighbourhoods).

`classifyMatch` returns `'exact'`, `'near'` (up to 10% outside the price band, half a room
off, or one must-have missing) or `null`. Near misses are sent with a "🤏 כמעט מתאים" header.

## Cities

`CITIES` is `mergeCities(GENERATED_CITIES, CURATED_CITIES)`. `cities.generated.ts` is written
by `npm run build-cities` from data.gov.il's locality list and Yad2's address autocomplete,
and is never edited by hand. A wrong Yad2 region code returns an empty city with HTTP 200, so
codes are never typed by hand. `CURATED_CITIES` keeps the original 17 cities and their keys.
Saved searches store keys, so a regeneration keeps every key already published.

The `/add` city step is type-to-search (`searchCities`: exact, then prefix, then anywhere in
the name). The free-text gate uses `mentionsCity`, which matches whole words only.

## State that survives restarts

- **Per-source cadence** lives in `kv` as `source_last_run:<adapter>`, measured on the clock.
  An in-memory counter used to reset on every restart and hammered a rate-limited source.
- **The pending queue** is the `seen_listings` rows with `notified_at IS NULL`. Quiet hours
  and the per-chat cap leave rows unsent; nothing is dropped.
- **`HealthTracker`** is in memory only: three failures in a row send one alert, and a block
  backs a source off exponentially (2, 4, 8, up to 16 cycles).

## Database

`better-sqlite3`, synchronous, WAL mode. `src/db/migrations.ts` is append-only and applied by
index at boot. Never edit a shipped migration; add a new one. All SQL lives in the
`*.repo.ts` files.

## HTTP

`src/util/http.ts` installs a global undici dispatcher at import time.

- Node's default TLS fingerprint is blocked by Cloudflare. The Chrome cipher order and HTTP/2
  are why requests get through at all.
- Being global, it also carries the Gemini SDK's requests; its timeouts exist because one
  hung model call once stretched a cycle to five minutes. Model calls go two at a time
  (`util/semaphore.ts`) with retries (`util/retry.ts`).
- Bot-challenge pages come back with HTTP 200, so `detectBlockPage` checks the body before the
  status, and a `BlockedError` is never retried. Retrying is what deepens a block.

## Conventions

- ESM with explicit `.js` extensions on relative imports. `strict` and
  `noUncheckedIndexedAccess` are on.
- Zod validates every boundary: environment, listings, model output.
- Telegram text is Hebrew; code, comments and logs are English.
- Comments explain why, and often record the failure that led to the code. Read them before
  changing it.
- Never log message bodies or raw responses.

## Tests

```bash
npm test                          # all tests
npm run typecheck                 # tsc --noEmit
npx vitest run test/filter.test.ts
```

`vitest.config.ts` sets a dummy bot token, an in-memory database and an empty Gemini key, so
tests never read your real `.env` and never call a live API.

## Running it

Sites only serve Israeli IP addresses properly, so run the bot from a home connection. Only
one process may poll a Telegram token; a second copy exits with a clear message. Don't run
`npm run probe` in a loop: it hits every source live, and repeated probing trips rate limits.
