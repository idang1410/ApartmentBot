import sharp from 'sharp';
import { logger } from '../logger.js';
import type { Listing } from './types.js';

/** Photos hashed per listing. */
const PHOTOS = 4;
const TIMEOUT_MS = 10_000;
/** Listings hashed at once; each downloads its photos one after another. */
const CONCURRENCY = 4;
/** The hash of a flat image, which every blank photo shares. */
const BLANK = '0'.repeat(16);

/**
 * The 64-bit difference hash of an image, as 16 hex digits. The image is
 * reduced to 9x8 grayscale and each bit says whether a pixel is brighter than
 * its right neighbour, so resizing, recompression and a light crop or
 * watermark change few bits.
 */
export async function dHash(image: Buffer): Promise<string> {
  const pixels = await sharp(image).removeAlpha().grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits = (bits << 1n) | (pixels[y * 9 + x]! > pixels[y * 9 + x + 1]! ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, '0');
}

/**
 * Sets `photoHashes` on each listing that has photos and no hashes yet, from
 * its first PHOTOS photos. A photo that fails to download or decode is
 * skipped; this never throws.
 */
export async function addPhotoHashes(listings: Listing[]): Promise<void> {
  const todo = listings.filter((l) => l.imageUrls.length > 0 && !l.photoHashes);
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    await Promise.all(todo.slice(i, i + CONCURRENCY).map(hashListing));
  }
}

async function hashListing(listing: Listing): Promise<void> {
  const hashes: string[] = [];
  for (const url of listing.imageUrls.slice(0, PHOTOS)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const hash = await dHash(Buffer.from(await response.arrayBuffer()));
      if (hash !== BLANK && !hashes.includes(hash)) hashes.push(hash);
    } catch (error) {
      logger.debug({ err: error, source: listing.source, url }, 'photo hash failed');
    }
  }
  if (hashes.length > 0) listing.photoHashes = hashes;
}
