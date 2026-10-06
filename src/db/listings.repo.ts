import { listingFingerprint, sameFlat, type Listing, type ListingCopy, type MatchKind } from '../core/types.js';
import { normalizePlace } from '../core/cities.js';
import {
  CLOSED_STATUSES,
  NOTE_LIMIT,
  findPhone,
  isTrackStatus,
  type TrackNote,
  type TrackStatus,
  type Tracking,
} from '../core/tracking.js';
import type { Db } from './database.js';

export interface PendingListing {
  listing: Listing;
  searchId: number | null;
  chatId: number;
  matchKind: MatchKind;
}

/** A tracked flat with the copy of the listing it was last shown as. */
export interface TrackedListing extends Tracking {
  listing: Listing;
  updatedAt: string;
}

interface TrackedRow {
  id: number;
  status: string | null;
  phone: string | null;
  notes: string | null;
  payload: string;
  updated_at: string;
}

export interface MatchedListing {
  listing: Listing;
  matchKind: MatchKind;
  searchId: number;
  /** SQLite UTC timestamp, "YYYY-MM-DD HH:MM:SS". */
  firstSeen: string;
}

/** Decides, per listing, whether it fit the search exactly or was a near miss. */
export type MatchKindOf = (listing: Listing) => MatchKind;

/**
 * Owns the promise that nobody is told about the same flat twice.
 *
 * Everything here is scoped to a chat. "Seen" is per person: two people
 * watching the same city must each be alerted, while one person with two
 * searches should hear about a listing once.
 */
export class ListingsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Listings this chat has never been shown, by source id or by fingerprint.
   *
   * The fingerprint check collapses the same flat arriving from two different
   * boards, both across cycles and within a single fetch.
   */
  selectUnseen(listings: Listing[], chatId: number): Listing[] {
    if (listings.length === 0) return [];

    const existsById = this.db.prepare(
      'SELECT 1 FROM seen_listings WHERE chat_id = ? AND source = ? AND listing_id = ?',
    );
    const existsByFingerprint = this.db.prepare(
      'SELECT 1 FROM seen_listings WHERE chat_id = ? AND fingerprint = ? LIMIT 1',
    );

    const seenThisBatch = new Set<string>();
    const unseen: Listing[] = [];

    for (const listing of listings) {
      if (existsById.get(chatId, listing.source, listing.sourceId) !== undefined) continue;

      const fingerprint = listingFingerprint(listing);
      if (fingerprint) {
        if (seenThisBatch.has(fingerprint)) continue;
        if (existsByFingerprint.get(chatId, fingerprint) !== undefined) continue;
        seenThisBatch.add(fingerprint);
      }

      unseen.push(listing);
    }

    return unseen;
  }

  /**
   * Records listings as already-notified without sending anything. Used the
   * first time a search runs, and the first time a source appears, so nobody
   * is buried under a back catalogue.
   */
  seedAsSeen(
    listings: Listing[],
    searchId: number,
    chatId: number,
    kindOf: MatchKindOf = () => 'exact',
  ): number {
    return this.insertMany(listings, searchId, chatId, sqliteNow(), kindOf);
  }

  /** Records listings awaiting notification (notified_at stays NULL). */
  recordPending(
    listings: Listing[],
    searchId: number,
    chatId: number,
    kindOf: MatchKindOf = () => 'exact',
  ): number {
    return this.insertMany(listings, searchId, chatId, null, kindOf);
  }

  /**
   * A listing already recorded for any chat, revived from its stored copy.
   * Lets a source hand back what it read before instead of reading it again.
   */
  findStored(source: string, sourceId: string): Listing | undefined {
    const row = this.db
      .prepare(
        `SELECT payload FROM seen_listings
          WHERE source = ? AND listing_id = ? AND payload IS NOT NULL LIMIT 1`,
      )
      .get(source, sourceId) as { payload: string } | undefined;
    if (!row) return undefined;
    try {
      return reviveListing(row.payload);
    } catch {
      return undefined;
    }
  }

  /** Sources this chat has already recorded listings from. */
  knownSources(chatId: number): Set<string> {
    const rows = this.db
      .prepare('SELECT DISTINCT source FROM seen_listings WHERE chat_id = ?')
      .all(chatId) as Array<{ source: string }>;
    return new Set(rows.map((r) => r.source));
  }

  /** True when this chat has already been sent this listing. */
  wasNotified(source: string, sourceId: string, chatId: number): boolean {
    const row = this.db
      .prepare(
        'SELECT notified_at FROM seen_listings WHERE chat_id = ? AND source = ? AND listing_id = ?',
      )
      .get(chatId, source, sourceId) as { notified_at: string | null } | undefined;
    return row?.notified_at != null;
  }

  /**
   * Finds listings this chat has already seen whose asking price has fallen,
   * and records the new price so the same drop is reported once.
   */
  findPriceDrops(
    listings: Listing[],
    chatId: number,
  ): Array<{ listing: Listing; previousPrice: number }> {
    const previous = this.db.prepare(
      'SELECT price FROM seen_listings WHERE chat_id = ? AND source = ? AND listing_id = ?',
    );
    const updatePrice = this.db.prepare(
      'UPDATE seen_listings SET price = ?, payload = ? WHERE chat_id = ? AND source = ? AND listing_id = ?',
    );

    const drops: Array<{ listing: Listing; previousPrice: number }> = [];

    for (const listing of listings) {
      if (listing.price === null) continue;

      const row = previous.get(chatId, listing.source, listing.sourceId) as
        | { price: number | null }
        | undefined;
      if (!row || row.price === null) continue;
      if (listing.price >= row.price) continue;

      if (!this.isClosed(listing, chatId)) drops.push({ listing, previousPrice: row.price });
      updatePrice.run(
        listing.price,
        JSON.stringify(listing),
        chatId,
        listing.source,
        listing.sourceId,
      );
    }

    return drops;
  }

  markNotified(source: string, sourceId: string, chatId: number): void {
    this.db
      .prepare(
        `UPDATE seen_listings SET notified_at = datetime('now')
         WHERE chat_id = ? AND source = ? AND listing_id = ?`,
      )
      .run(chatId, source, sourceId);
  }

  /**
   * Everything recorded but not yet sent, for every chat, oldest first.
   *
   * Rows belonging to a search that no longer exists are skipped. The queue
   * outlives the search that filled it - a batch collected minutes before a
   * search was deleted would otherwise keep arriving afterwards, advertising
   * cities the owner had just removed. Rows with no search at all predate
   * multi-user support and are still owed to the owner.
   */
  pending(): PendingListing[] {
    const rows = this.db
      .prepare(
        `SELECT payload, search_id, chat_id, match_kind FROM seen_listings
         WHERE notified_at IS NULL
           AND (search_id IS NULL
                OR search_id IN (SELECT id FROM saved_searches))
         ORDER BY first_seen`,
      )
      .all() as Array<{
      payload: string | null;
      search_id: number | null;
      chat_id: number;
      match_kind: string | null;
    }>;

    const pending: PendingListing[] = [];
    for (const row of rows) {
      if (!row.payload) continue;
      try {
        pending.push({
          listing: reviveListing(row.payload),
          searchId: row.search_id,
          chatId: row.chat_id,
          // Rows from before the column existed are NULL, and were exact.
          matchKind: row.match_kind === 'near' ? 'near' : 'exact',
        });
      } catch {
        // A payload we can no longer read must not stall the queue forever.
        continue;
      }
    }
    return pending;
  }

  /**
   * Drops a deleted search's unsent listings from the queue.
   *
   * They are marked as notified rather than deleted, so the chat still counts
   * as having seen them: adding that city back later seeds quietly instead of
   * replaying everything as new. Returns how many were discarded.
   */
  discardPending(searchId: number): number {
    return this.db
      .prepare(
        `UPDATE seen_listings SET notified_at = datetime('now')
          WHERE search_id = ? AND notified_at IS NULL`,
      )
      .run(searchId).changes;
  }

  /**
   * Neighbourhoods actually seen advertised in a city, most common first.
   *
   * Yad2's autocomplete caps its neighbourhood list at four entries, so the
   * only complete source is what has come through the sources themselves.
   * The upside is that every suggestion is somewhere with real inventory;
   * the downside is a city nobody has polled yet offers nothing, which is
   * why the wizard also lets a name be typed.
   *
   * Spelling varies between sources - רמב"ם, רמב''ם and רמב``ם all occur -
   * so entries are grouped by their normalized form and the most frequently
   * used spelling wins.
   */
  knownAreas(cityName: string, limit = 12): string[] {
    const rows = this.db
      .prepare(`SELECT payload FROM seen_listings WHERE payload IS NOT NULL`)
      .all() as Array<{ payload: string }>;

    const target = normalizePlace(cityName);
    const groups = new Map<string, Map<string, number>>();

    for (const row of rows) {
      let listing: { city?: unknown; neighborhood?: unknown };
      try {
        listing = JSON.parse(row.payload) as typeof listing;
      } catch {
        continue;
      }

      const city = typeof listing.city === 'string' ? listing.city : '';
      const hood = typeof listing.neighborhood === 'string' ? listing.neighborhood.trim() : '';
      if (!hood || normalizePlace(city) !== target) continue;

      // A source that repeats the city as the neighbourhood tells us nothing.
      const key = normalizePlace(hood);
      if (!key || key === target) continue;

      const spellings = groups.get(key) ?? new Map<string, number>();
      spellings.set(hood, (spellings.get(hood) ?? 0) + 1);
      groups.set(key, spellings);
    }

    return [...groups.values()]
      .map((spellings) => {
        const ranked = [...spellings].sort((a, b) => b[1] - a[1]);
        return { name: ranked[0]![0], count: ranked.reduce((sum, [, n]) => sum + n, 0) };
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'he'))
      .slice(0, limit)
      .map((entry) => entry.name);
  }

  countSince(iso: string, chatId?: number): number {
    const row = (
      chatId === undefined
        ? this.db.prepare('SELECT COUNT(*) AS n FROM seen_listings WHERE first_seen >= ?').get(iso)
        : this.db
            .prepare('SELECT COUNT(*) AS n FROM seen_listings WHERE first_seen >= ? AND chat_id = ?')
            .get(iso, chatId)
    ) as { n: number };
    return row.n;
  }

  /**
   * Listings that matched one of this chat's active searches in the last
   * `days`, newest first, one per fingerprint. With `kindOf`, every stored
   * listing of the chat is a candidate, whichever search stored it: the match
   * kind is worked out again and a listing it returns null for is left out.
   */
  matchedRecently(
    chatId: number,
    days: number,
    kindOf?: (listing: Listing, searchId: number) => MatchKind | null,
  ): MatchedListing[] {
    const rows = this.db
      .prepare(
        `SELECT l.payload, l.match_kind, l.search_id, l.first_seen, l.fingerprint FROM seen_listings l
           ${kindOf ? '' : 'JOIN saved_searches s ON s.id = l.search_id AND s.active = 1'}
          WHERE l.chat_id = ? AND l.payload IS NOT NULL
            AND COALESCE(l.match_kind, 'exact') IN ('exact', 'near')
            AND l.first_seen >= datetime('now', ?)
          ORDER BY l.first_seen DESC`,
      )
      .all(chatId, `-${days} days`) as Array<{
      payload: string;
      match_kind: string | null;
      search_id: number;
      first_seen: string;
      fingerprint: string | null;
    }>;

    const seen = new Set<string>();
    const matched: MatchedListing[] = [];
    for (const row of rows) {
      if (row.fingerprint && seen.has(row.fingerprint)) continue;
      let listing: Listing;
      try {
        listing = reviveListing(row.payload);
      } catch {
        // An unreadable payload is left off the map.
        continue;
      }
      const matchKind = kindOf ? kindOf(listing, row.search_id) : row.match_kind === 'near' ? 'near' : 'exact';
      if (matchKind === null) continue;
      if (row.fingerprint) seen.add(row.fingerprint);
      matched.push({ listing, matchKind, searchId: row.search_id, firstSeen: row.first_seen });
    }
    return matched;
  }

  total(chatId?: number): number {
    const row = (
      chatId === undefined
        ? this.db.prepare('SELECT COUNT(*) AS n FROM seen_listings').get()
        : this.db.prepare('SELECT COUNT(*) AS n FROM seen_listings WHERE chat_id = ?').get(chatId)
    ) as { n: number };
    return row.n;
  }

  /** Keeps the table from growing without bound; ids this old will not recur. */
  pruneOlderThanMonths(months: number): number {
    const result = this.db
      .prepare(`DELETE FROM seen_listings WHERE first_seen < date('now', ?)`)
      .run(`-${months} months`);
    return result.changes;
  }

  /**
   * The key a listing is tracked under for this chat. A recorded listing keeps
   * the fingerprint it was first seen with, so a price drop, which changes the
   * fingerprint, still finds the same flat.
   */
  private trackingKey(listing: Listing, chatId: number): string {
    const row = this.db
      .prepare(
        `SELECT COALESCE(fingerprint, source || ':' || listing_id) AS key FROM seen_listings
          WHERE chat_id = ? AND source = ? AND listing_id = ?`,
      )
      .get(chatId, listing.source, listing.sourceId) as { key: string } | undefined;
    return row?.key ?? listingFingerprint(listing) ?? `${listing.source}:${listing.sourceId}`;
  }

  /** The tracking id for a listing, created on first use; the stored copy is refreshed. */
  track(listing: Listing, chatId: number): number {
    const row = this.db
      .prepare(
        `INSERT INTO tracked_listings (chat_id, fingerprint, payload) VALUES (?, ?, ?)
         ON CONFLICT (chat_id, fingerprint) DO UPDATE SET payload = excluded.payload
         RETURNING id`,
      )
      .get(chatId, this.trackingKey(listing, chatId), JSON.stringify(listing)) as { id: number };
    return row.id;
  }

  /** A tracked flat, only if it belongs to this chat. */
  tracked(id: number, chatId: number): TrackedListing | undefined {
    const row = this.db
      .prepare('SELECT * FROM tracked_listings WHERE id = ? AND chat_id = ?')
      .get(id, chatId) as TrackedRow | undefined;
    return row ? toTracked(row) : undefined;
  }

  /** What this chat recorded about a listing, without creating anything. */
  trackingOf(listing: Listing, chatId: number): Tracking | undefined {
    const row = this.db
      .prepare('SELECT * FROM tracked_listings WHERE chat_id = ? AND fingerprint = ?')
      .get(chatId, this.trackingKey(listing, chatId)) as TrackedRow | undefined;
    return row ? toTracked(row) : undefined;
  }

  setStatus(id: number, chatId: number, status: TrackStatus): boolean {
    return (
      this.db
        .prepare(
          `UPDATE tracked_listings SET status = ?, updated_at = datetime('now')
            WHERE id = ? AND chat_id = ?`,
        )
        .run(status, id, chatId).changes > 0
    );
  }

  /** Appends a note, cut to NOTE_LIMIT, and records the phone number it names, if any. */
  addNote(id: number, chatId: number, text: string): TrackedListing | undefined {
    const current = this.tracked(id, chatId);
    const note = text.trim().slice(0, NOTE_LIMIT);
    if (!current || !note) return undefined;
    const notes: TrackNote[] = [...current.notes, { at: sqliteNow(), text: note }];
    const phone = findPhone(note) ?? current.phone;
    this.db
      .prepare(
        `UPDATE tracked_listings SET notes = ?, phone = ?, updated_at = datetime('now')
          WHERE id = ? AND chat_id = ?`,
      )
      .run(JSON.stringify(notes), phone, id, chatId);
    return { ...current, notes, phone };
  }

  /** Flats this chat set a status on or wrote about, most recently touched first. */
  listTracked(chatId: number, includeRejected: boolean): TrackedListing[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tracked_listings
          WHERE chat_id = ? AND (status IS NOT NULL OR notes IS NOT NULL)
            AND (? OR COALESCE(status, '') != 'rejected')
          ORDER BY updated_at DESC`,
      )
      .all(chatId, includeRejected ? 1 : 0) as TrackedRow[];
    return rows.map(toTracked);
  }

  /**
   * True when this chat marked the flat rejected or taken, under the key it was
   * recorded with or under its fingerprint as listed now - the second is how
   * a sighting on another board is caught.
   */
  isClosed(listing: Listing, chatId: number): boolean {
    const keys = [this.trackingKey(listing, chatId), listingFingerprint(listing)];
    const closed = this.db.prepare(
      `SELECT 1 FROM tracked_listings WHERE chat_id = ? AND fingerprint = ?
          AND status IN (${CLOSED_STATUSES.map(() => '?').join(', ')})`,
    );
    return keys.some((key) => key !== null && closed.get(chatId, key, ...CLOSED_STATUSES) !== undefined);
  }

  /**
   * This chat's other stored listings of the same flat from the last `days`,
   * from any search and from its tracked flats, one per source id. A copy the
   * chat tracked carries its status.
   */
  copiesOf(listing: Listing, chatId: number, days = 60): ListingCopy[] {
    if (!listing.address || listing.rooms === null) return [];
    const rows = this.db
      .prepare(
        `SELECT payload, status FROM tracked_listings
          WHERE chat_id = ? AND json_extract(payload, '$.rooms') = ? AND updated_at >= datetime('now', ?)
         UNION ALL
         SELECT payload, NULL FROM seen_listings
          WHERE chat_id = ? AND payload IS NOT NULL AND json_extract(payload, '$.rooms') = ?
            AND first_seen >= datetime('now', ?)`,
      )
      .all(chatId, listing.rooms, `-${days} days`, chatId, listing.rooms, `-${days} days`) as Array<{
      payload: string;
      status: string | null;
    }>;

    const copies = new Map<string, ListingCopy>();
    for (const row of rows) {
      let other: Listing;
      try {
        other = reviveListing(row.payload);
      } catch {
        continue;
      }
      const key = `${other.source}:${other.sourceId}`;
      if (copies.has(key) || key === `${listing.source}:${listing.sourceId}`) continue;
      const kind = sameFlat(listing, other);
      if (!kind) continue;
      const status = isTrackStatus(row.status) ? row.status : (this.trackingOf(other, chatId)?.status ?? null);
      copies.set(key, { listing: other, kind, status });
    }
    return [...copies.values()];
  }

  /** A listing this chat has recorded, by its source id. */
  findSeen(source: string, sourceId: string, chatId: number): Listing | undefined {
    const row = this.db
      .prepare(
        `SELECT payload FROM seen_listings
          WHERE chat_id = ? AND source = ? AND listing_id = ? AND payload IS NOT NULL`,
      )
      .get(chatId, source, sourceId) as { payload: string } | undefined;
    return row ? reviveListing(row.payload) : undefined;
  }

  private insertMany(
    listings: Listing[],
    searchId: number,
    chatId: number,
    notifiedAt: string | null,
    kindOf: MatchKindOf,
  ): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO seen_listings
         (chat_id, source, listing_id, search_id, price, url, payload, notified_at, fingerprint, match_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const run = this.db.transaction((items: Listing[]) => {
      let inserted = 0;
      for (const l of items) {
        const result = insert.run(
          chatId,
          l.source,
          l.sourceId,
          searchId,
          l.price,
          l.url,
          JSON.stringify(l),
          notifiedAt,
          listingFingerprint(l),
          kindOf(l),
        );
        inserted += result.changes;
      }
      return inserted;
    });

    return run(listings);
  }
}

/**
 * Matches SQLite's own datetime('now') format so timestamps written from
 * JavaScript sort and compare against column defaults.
 */
export function sqliteNow(at: Date = new Date()): string {
  return at.toISOString().replace('T', ' ').slice(0, 19);
}

function toTracked(row: TrackedRow): TrackedListing {
  return {
    id: row.id,
    status: isTrackStatus(row.status) ? row.status : null,
    phone: row.phone,
    notes: row.notes ? (JSON.parse(row.notes) as TrackNote[]) : [],
    listing: reviveListing(row.payload),
    updatedAt: row.updated_at,
  };
}

function reviveListing(payload: string): Listing {
  const parsed = JSON.parse(payload) as Listing & { postedAt?: string; entryDate?: string };
  return {
    ...parsed,
    ...(parsed.postedAt ? { postedAt: new Date(parsed.postedAt) } : {}),
    ...(parsed.entryDate ? { entryDate: new Date(parsed.entryDate) } : {}),
  };
}
