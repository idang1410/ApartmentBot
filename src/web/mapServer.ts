import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { geocodeQuery, type Geocoder } from '../core/geocode.js';
import { isTrackStatus, NOTE_LIMIT, type Tracking } from '../core/tracking.js';
import type { Listing } from '../core/types.js';
import { KV_KEYS, type KvRepo } from '../db/kv.repo.js';
import type { ListingsRepo, MatchedListing } from '../db/listings.repo.js';
import { logger } from '../logger.js';
import { MAP_PAGE } from './mapPage.js';

/** How far back the map reaches. */
export const MAP_DAYS = 14;

/** One listing as the map page draws it. */
export interface MapPin {
  lat: number;
  lng: number;
  /** Placed by neighbourhood, not by street. */
  approximate: boolean;
  matchKind: 'exact' | 'near';
  firstSeen: string;
  price: number | null;
  rooms: number | null;
  sqm?: number;
  place: string;
  source: string;
  url: string;
  image?: string;
  /** `source:sourceId`, how the page names the listing when it posts a change. */
  ref: string;
  status?: Tracking['status'];
  phone?: string;
  notes?: Tracking['notes'];
}

/** Largest POST body accepted. */
const BODY_LIMIT = 4_096;

/** This chat's map secret, created on first use. */
export function mapTokenFor(kv: KvRepo, chatId: number): string {
  const key = `${KV_KEYS.mapTokenPrefix}${chatId}`;
  const existing = kv.get(key);
  if (existing) return existing;
  const token = randomBytes(18).toString('base64url');
  kv.set(key, token);
  return token;
}

/** The chat a map token belongs to; undefined for anything else. */
export function chatForToken(kv: KvRepo, token: string | null): number | undefined {
  if (!token || !/^[\w-]{16,}$/.test(token)) return undefined;
  const key = kv.findKey(KV_KEYS.mapTokenPrefix, token);
  if (!key) return undefined;
  const chatId = Number(key.slice(KV_KEYS.mapTokenPrefix.length));
  return Number.isInteger(chatId) ? chatId : undefined;
}

/**
 * Places matched listings on the map. Source coordinates win; otherwise the
 * geocode cache is used, and a place not asked yet is queued so a later
 * request finds it. `pending` counts those queued lookups.
 */
export function mapPins(
  matched: MatchedListing[],
  geocoder: Geocoder,
  trackingOf: (listing: Listing) => Tracking | undefined = () => undefined,
): { pins: MapPin[]; pending: number } {
  const pins: MapPin[] = [];
  let pending = 0;

  for (const { listing, matchKind, firstSeen } of matched) {
    let point = listing.lat !== undefined && listing.lng !== undefined
      ? { lat: listing.lat, lng: listing.lng }
      : null;
    let approximate = false;

    if (!point) {
      const query = geocodeQuery(listing);
      if (!query) continue;
      const hit = geocoder.cached(query.place, query.city);
      if (hit === undefined) {
        pending++;
        geocoder
          .locate(query.place, query.city)
          .catch((err: unknown) => logger.warn({ err }, 'geocoding failed'));
        continue;
      }
      if (!hit) continue;
      point = hit;
      approximate = query.approximate;
    }

    pins.push({
      ...point,
      approximate,
      matchKind,
      firstSeen: `${firstSeen.replace(' ', 'T')}Z`,
      price: listing.price,
      rooms: listing.rooms,
      ...(listing.sqm ? { sqm: listing.sqm } : {}),
      place: [listing.address, listing.neighborhood, listing.city].filter(Boolean).join(', '),
      source: listing.originalSource ?? listing.source,
      url: listing.url,
      ...(listing.imageUrls[0] ? { image: listing.imageUrls[0] } : {}),
      ref: `${listing.source}:${listing.sourceId}`,
      ...trackingFields(trackingOf(listing), listing.phone),
    });
  }

  return { pins, pending };
}

function trackingFields(
  tracking: Tracking | undefined,
  adPhone?: string,
): Pick<MapPin, 'status' | 'phone' | 'notes'> {
  const phone = tracking?.phone ?? adPhone;
  return {
    ...(tracking?.status ? { status: tracking.status } : {}),
    ...(phone ? { phone } : {}),
    ...(tracking?.notes.length ? { notes: tracking.notes } : {}),
  };
}

/**
 * Applies a status or note posted from the map: `{ref, status}` to
 * /api/status, `{ref, text}` to /api/note. Returns the HTTP status and body.
 */
export function applyMapChange(
  listings: ListingsRepo,
  chatId: number,
  path: string,
  body: unknown,
): { code: number; body?: Pick<MapPin, 'status' | 'phone' | 'notes'> } {
  const { ref, status, text } = (body ?? {}) as Record<string, unknown>;
  const [, source, sourceId] = typeof ref === 'string' ? (/^([^:]+):(.+)$/.exec(ref) ?? []) : [];
  const listing = source && sourceId ? listings.findSeen(source, sourceId, chatId) : undefined;
  if (!listing) return { code: 404 };

  if (path === '/api/status') {
    if (!isTrackStatus(status)) return { code: 400 };
    listings.setStatus(listings.track(listing, chatId), chatId, status);
  } else if (path === '/api/note') {
    if (typeof text !== 'string' || !text.trim() || text.length > NOTE_LIMIT) return { code: 400 };
    listings.addNote(listings.track(listing, chatId), chatId, text);
  } else {
    return { code: 404 };
  }
  return { code: 200, body: trackingFields(listings.trackingOf(listing, chatId), listing.phone) };
}

/** The first non-internal IPv4 address, which a phone on the same Wi-Fi can reach. */
export function lanAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return undefined;
}

/**
 * Serves the map on every interface. Every request needs a chat's token as
 * `?t=`; anything else gets a 404, so the port reveals nothing without it.
 */
export function startMapServer(deps: {
  listings: ListingsRepo;
  kv: KvRepo;
  geocoder: Geocoder;
  port: number;
}): Server {
  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      // The process exits on any uncaught exception; one bad request must not cause that.
      logger.error({ err }, 'map request failed');
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chatId = chatForToken(deps.kv, url.searchParams.get('t'));

    if (chatId === undefined) {
      res.writeHead(404).end();
    } else if (req.method === 'POST') {
      handlePost(req, res, chatId, url.pathname);
    } else if (req.method !== 'GET') {
      res.writeHead(404).end();
    } else if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(MAP_PAGE);
    } else if (url.pathname === '/api/listings') {
      const data = mapPins(
        deps.listings.matchedRecently(chatId, MAP_DAYS),
        deps.geocoder,
        (listing) => deps.listings.trackingOf(listing, chatId),
      );
      res
        .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify(data));
    } else {
      res.writeHead(404).end();
    }
  }

  /** A status or note change; the body is JSON of at most BODY_LIMIT bytes. */
  function handlePost(req: IncomingMessage, res: ServerResponse, chatId: number, path: string): void {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    req.on('end', () => {
      let body: unknown;
      try {
        body = size > BODY_LIMIT ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = undefined;
      }
      try {
        const result = body === undefined ? { code: 400 } : applyMapChange(deps.listings, chatId, path, body);
        res
          .writeHead(result.code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(JSON.stringify(result.body ?? {}));
      } catch (err) {
        logger.error({ err }, 'map request failed');
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
  }

  // A busy port costs the map, not the bot.
  server.on('error', (err) => logger.error({ err, port: deps.port }, 'map server failed'));
  server.listen(deps.port, '0.0.0.0', () => logger.info({ port: deps.port }, 'map server listening'));
  return server;
}
