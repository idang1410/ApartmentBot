import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { geocodeQuery, type Geocoder } from '../core/geocode.js';
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
}

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
    });
  }

  return { pins, pending };
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

    if (req.method !== 'GET' || chatId === undefined) {
      res.writeHead(404).end();
    } else if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(MAP_PAGE);
    } else if (url.pathname === '/api/listings') {
      const data = mapPins(deps.listings.matchedRecently(chatId, MAP_DAYS), deps.geocoder);
      res
        .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify(data));
    } else {
      res.writeHead(404).end();
    }
  }

  // A busy port costs the map, not the bot.
  server.on('error', (err) => logger.error({ err, port: deps.port }, 'map server failed'));
  server.listen(deps.port, '0.0.0.0', () => logger.info({ port: deps.port }, 'map server listening'));
  return server;
}
