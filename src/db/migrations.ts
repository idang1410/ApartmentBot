/**
 * Applied in order at boot; `schema_version` records how far we got.
 * Never edit a shipped migration - add another one.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE saved_searches (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    city_key   TEXT    NOT NULL,
    city_name  TEXT    NOT NULL,
    min_rooms  REAL,
    max_rooms  REAL,
    min_price  INTEGER,
    max_price  INTEGER,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE seen_listings (
    source      TEXT NOT NULL,
    listing_id  TEXT NOT NULL,
    search_id   INTEGER,
    first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
    price       INTEGER,
    url         TEXT,
    payload     TEXT,
    notified_at TEXT,
    PRIMARY KEY (source, listing_id)
  );

  CREATE INDEX idx_seen_pending ON seen_listings (notified_at) WHERE notified_at IS NULL;

  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // Same flat, two boards: Yad2 lists it and Realta re-publishes it, so the
  // (source, listing_id) key alone would alert twice for one apartment.
  `
  ALTER TABLE seen_listings ADD COLUMN fingerprint TEXT;
  CREATE INDEX idx_seen_fingerprint ON seen_listings (fingerprint);
  `,
  // More than one person can use the bot. Each search belongs to the chat that
  // created it, and its alerts go back to that chat only.
  `
  ALTER TABLE saved_searches ADD COLUMN chat_id INTEGER;
  CREATE INDEX idx_searches_chat ON saved_searches (chat_id);

  CREATE TABLE users (
    chat_id    INTEGER PRIMARY KEY,
    name       TEXT,
    is_owner   INTEGER NOT NULL DEFAULT 0,
    joined_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE invites (
    code       TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    used_by    INTEGER,
    used_at    TEXT
  );
  `,
  // One search can cover several cities - someone looking in Modi'in will often
  // consider Rishon LeZion too, and that is one set of criteria, not two
  // searches to keep in step. Stored as a JSON array; city_key stays as the
  // first entry so older rows keep working.
  `
  ALTER TABLE saved_searches ADD COLUMN city_keys TEXT;
  UPDATE saved_searches SET city_keys = json_array(city_key) WHERE city_keys IS NULL;
  `,
  // "Already seen" is per person, not global.
  //
  // The old key was (source, listing_id), written when there was one user.
  // Once a second person joined, whoever polled first claimed a listing and
  // nobody else could be alerted about it - the second user silently received
  // almost nothing. The key now includes the chat, so each person has their own
  // seen-set while two searches belonging to the SAME person still share one.
  `
  CREATE TABLE seen_listings_v2 (
    chat_id     INTEGER NOT NULL,
    source      TEXT NOT NULL,
    listing_id  TEXT NOT NULL,
    search_id   INTEGER,
    first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
    price       INTEGER,
    url         TEXT,
    payload     TEXT,
    notified_at TEXT,
    fingerprint TEXT,
    PRIMARY KEY (chat_id, source, listing_id)
  );

  INSERT OR IGNORE INTO seen_listings_v2
    (chat_id, source, listing_id, search_id, first_seen, price, url, payload, notified_at, fingerprint)
  SELECT COALESCE(s.chat_id, 0), l.source, l.listing_id, l.search_id,
         l.first_seen, l.price, l.url, l.payload, l.notified_at, l.fingerprint
    FROM seen_listings l
    LEFT JOIN saved_searches s ON s.id = l.search_id;

  DROP TABLE seen_listings;
  ALTER TABLE seen_listings_v2 RENAME TO seen_listings;

  CREATE INDEX idx_seen_pending ON seen_listings (notified_at) WHERE notified_at IS NULL;
  CREATE INDEX idx_seen_fingerprint ON seen_listings (chat_id, fingerprint);
  `,
  // Streets and neighbourhoods per city, as JSON keyed by city key. A city
  // that is absent is searched whole, which is what every existing row means.
  `
  ALTER TABLE saved_searches ADD COLUMN areas TEXT;
  `,
  // Whether a recorded listing fit the search exactly or was a near miss
  // (just outside a price or room bound). The alert that finally goes out,
  // possibly cycles later, must say which. NULL on old rows means exact.
  `
  ALTER TABLE seen_listings ADD COLUMN match_kind TEXT;
  `,
  // Must-have amenities, no-broker, minimum size, property types, keywords -
  // as JSON, like areas. NULL means no requirements, which is what every
  // existing row means.
  `
  ALTER TABLE saved_searches ADD COLUMN requirements TEXT;
  `,
  // Nominatim answers for the map, kept for good: its usage policy asks
  // clients to cache. NULL lat/lng records a place it could not find.
  `
  CREATE TABLE geocode_cache (
    key        TEXT PRIMARY KEY,
    lat        REAL,
    lng        REAL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
];
