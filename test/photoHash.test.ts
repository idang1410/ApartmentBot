import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addPhotoHashes, dHash } from '../src/core/photoHash.js';
import { hammingDistance, type Listing } from '../src/core/types.js';
import { adImages } from '../src/sources/facebook/fbBrowser.js';
import { normalizeMadlanBulletins } from '../src/sources/madlan/madlanNormalize.js';
import { parseOnmapListings } from '../src/sources/onmap/onmapNormalize.js';

/** A 320x240 photo-like image of smooth waves, fixed by `seed`. */
function photo(seed: number): Promise<Buffer> {
  const width = 320;
  const height = 240;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value =
        128 +
        60 * Math.sin(x / (20 + seed * 7) + seed) +
        40 * Math.cos(y / (15 + seed * 5) + seed * 2) +
        25 * Math.sin((x + y) / (30 + seed * 3));
      pixels.fill(Math.round(value), (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

describe('dHash', () => {
  it('keeps an edited copy of a photo close and a different photo far', async () => {
    const original = await photo(1);
    const hash = await dHash(original);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);

    const resized = await sharp(original).resize(160).jpeg({ quality: 40 }).toBuffer();
    const cropped = await sharp(original).extract({ left: 6, top: 5, width: 308, height: 230 }).toBuffer();
    const watermark = await sharp({ create: { width: 60, height: 16, channels: 3, background: '#fff' } }).png().toBuffer();
    const marked = await sharp(original).composite([{ input: watermark, left: 250, top: 215 }]).webp().toBuffer();
    for (const edited of [resized, cropped, marked]) {
      expect(hammingDistance(hash, await dHash(edited))).toBeLessThanOrEqual(6);
    }

    expect(hammingDistance(hash, await dHash(await photo(3)))).toBeGreaterThan(12);
  });
});

describe('addPhotoHashes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hashes the first four photos, skips failures, and leaves hashed listings alone', async () => {
    const image = await photo(2);
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      if (url.endsWith('/down.jpg')) throw new Error('offline');
      if (url.endsWith('/missing.jpg')) return new Response('', { status: 404 });
      return new Response(new Uint8Array(image));
    });
    const urls = ['a', 'down', 'missing', 'b', 'e'].map((name) => `https://img.example/${name}.jpg`);
    const fresh = listing({ imageUrls: urls });
    const hashed = listing({ imageUrls: urls, photoHashes: ['0123456789abcdef'] });
    const broken = listing({ imageUrls: [urls[1]!] });

    await addPhotoHashes([fresh, hashed, broken, listing()]);

    expect(fresh.photoHashes).toEqual([await dHash(image)]);
    expect(hashed.photoHashes).toEqual(['0123456789abcdef']);
    expect(broken.photoHashes).toBeUndefined();
    expect(fetched.filter((u) => u.endsWith('/e.jpg'))).toEqual([]);
  });
});

describe('ad photos', () => {
  it('keeps wide Facebook CDN images above the suggestions', () => {
    const cdn = 'https://scontent.ftlv1-1.fna.fbcdn.net/v/t39/';
    expect(
      adImages([
        { src: `${cdn}1.jpg`, width: 500, top: 0 },
        { src: `${cdn}avatar.jpg`, width: 40, top: 0 },
        { src: 'https://static.xx.fbcdn.net/emoji.png', width: 200, top: 0 },
        { src: `${cdn}1.jpg`, width: 200, top: 0 },
        { src: `${cdn}suggested.jpg`, width: 200, top: 1_500 },
        { src: `${cdn}2.jpg`, width: 150, top: 300 },
      ]),
    ).toEqual([`${cdn}1.jpg`, `${cdn}2.jpg`]);
  });

  it('reads Madlan image paths and OnMap gallery images', () => {
    const [madlan] = normalizeMadlanBulletins(
      [
        {
          id: 'm1',
          dealType: 'unitRent',
          addressDetails: { city: 'תל אביב יפו' },
          images: [{ imageUrl: '/bulletins/a b.jpeg' }, { imageUrl: 'bulletins/c.jpg' }],
        },
      ],
      { key: 'tel-aviv', name: 'תל אביב יפו', aliases: [] },
    );
    expect(madlan!.imageUrls).toEqual([
      'https://images2.madlan.co.il/t:nonce:v=2;resize:width=640/bulletins/a%20b.jpeg',
      'https://images2.madlan.co.il/t:nonce:v=2;resize:width=640/bulletins/c.jpg',
    ]);

    const [onmap] = parseOnmapListings(
      { data: [{ id: 'o1', images: [{ thumbnail: 'https://onmap.pro/images/1.thumbnail.webp', gallery: 'https://onmap.pro/images/1.gallery.webp' }] }] },
      'תל אביב יפו',
    );
    expect(onmap!.imageUrls).toEqual(['https://onmap.pro/images/1.gallery.webp']);
  });
});

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: 'yad2',
    sourceId: 'x',
    url: 'https://www.yad2.co.il/realestate/item/x',
    price: 6_000,
    rooms: 3,
    city: 'תל אביב יפו',
    amenities: [],
    imageUrls: [],
    ...overrides,
  };
}
