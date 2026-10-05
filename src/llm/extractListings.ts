import * as cheerio from 'cheerio';
import { z } from 'zod';
import { logger } from '../logger.js';
import { generateJson, isGeminiConfigured } from './gemini.js';

/**
 * Turns any rental page into structured listings with one model call.
 *
 * The point is to avoid hand-writing a CSS-selector parser per site. Adding a
 * source becomes a URL plus a city name, and a site redesign stops being a
 * silent breakage - the model reads whatever the page now says.
 *
 * The trade-off is cost and latency, which is why these sources run on a slow
 * cadence while the two native parsers (Realta's JSON, Homeless's mobile HTML)
 * keep running every cycle.
 */

/**
 * Every field is optional as well as nullable.
 *
 * The model does not always emit a key it has nothing to say about - it omits
 * it rather than sending null - and a strict schema rejected the entire page
 * over one missing `externalId`, silently losing a whole source. Missing and
 * null must mean the same thing here.
 */
const nullableString = z.string().nullish().transform((v) => v ?? null);
/**
 * An impossible number means "unknown", not "reject". A `rooms: 0` from the
 * model once failed a strict schema and discarded every listing on the page.
 */
const positiveOrNull = z.number().nullish().transform((v) => (v && v > 0 ? v : null));
const positiveIntOrNull = z
  .number()
  .nullish()
  .transform((v) => (v && v > 0 ? Math.round(v) : null));

const extractedItemSchema = z.object({
  externalId: nullableString,
  url: nullableString,
  price: positiveIntOrNull,
  rooms: positiveOrNull,
  sqm: positiveOrNull,
  city: nullableString,
  neighborhood: nullableString,
  street: nullableString,
  floor: nullableString,
  propertyType: nullableString,
  amenities: z.array(z.string()).nullish().transform((v) => v ?? []),
  isBroker: z.boolean().nullish().transform((v) => v ?? null),
  description: nullableString,
  postedText: nullableString,
  entryText: nullableString,
  imageUrl: nullableString,
});

export type ExtractedListing = z.infer<typeof extractedItemSchema>;

/**
 * Validates the model's reply one listing at a time, so a single unreadable
 * entry costs that entry rather than the whole page.
 */
export function parseExtracted(json: unknown): ExtractedListing[] {
  const outer = z.object({ listings: z.array(z.unknown()).nullish() }).safeParse(json);
  if (!outer.success) return [];

  const listings: ExtractedListing[] = [];
  let rejected = 0;
  for (const raw of outer.data.listings ?? []) {
    const parsed = extractedItemSchema.safeParse(raw);
    if (parsed.success) listings.push(parsed.data);
    else rejected++;
  }
  if (rejected > 0) {
    logger.warn({ rejected, kept: listings.length }, 'dropped unreadable extracted listings');
  }
  return listings;
}

const responseSchema = {
  type: 'object',
  properties: {
    listings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          externalId: { type: 'string', nullable: true, description: 'The site’s own listing id, from the listing link if present' },
          url: { type: 'string', nullable: true, description: 'Absolute or site-relative link to the listing page' },
          price: { type: 'integer', nullable: true, description: 'Monthly rent in NIS, digits only' },
          rooms: { type: 'number', nullable: true },
          sqm: { type: 'integer', nullable: true },
          city: { type: 'string', nullable: true, description: 'City in Hebrew' },
          neighborhood: { type: 'string', nullable: true, description: 'Neighbourhood in Hebrew' },
          street: { type: 'string', nullable: true },
          floor: { type: 'string', nullable: true, description: 'e.g. "קומה 2" or "קומת קרקע"' },
          propertyType: { type: 'string', nullable: true, description: 'דירה, דירת גן, יחידת דיור, פנטהאוז, דופלקס, בית פרטי, סטודיו' },
          amenities: { type: 'array', items: { type: 'string' }, description: 'Hebrew labels: חניה, מעלית, מרפסת, ממ״ד, מחסן, מיזוג, מרוהטת, משופצת, חיות מחמד, גינה, מקלט (shelter or ממ״ק in the building)' },
          isBroker: { type: 'boolean', nullable: true, description: 'true for agency/תיווך, false for private/ללא תיווך' },
          description: { type: 'string', nullable: true, description: 'One short Hebrew sentence. No phone numbers.' },
          postedText: {
            type: 'string',
            nullable: true,
            description: 'The posting/update date EXACTLY as written on the page, e.g. "היום", "אתמול", "לפני 3 ימים", "10/08/2023". null if the page shows none.',
          },
          entryText: {
            type: 'string',
            nullable: true,
            description: 'The move-in date EXACTLY as written, e.g. "מיידי", "1.10", "אמצע אוקטובר". null if the ad shows none.',
          },
          imageUrl: {
            type: 'string',
            nullable: true,
            description: "The listing's photo URL exactly as it appears in the IMAGES list. null if it has none.",
          },
        },
        required: ['amenities'],
      },
    },
  },
  required: ['listings'],
};

function buildPrompt(city: string, pageText: string): string {
  return `אתה מחלץ מודעות שכירות מתוכן של דף אינטרנט ישראלי.

המשימה: החזר JSON עם כל מודעות ה**השכרה** שמופיעות בדף עבור העיר "${city}".

כללים מחייבים:
- כלול רק מודעות להשכרה של **דירת מגורים**.
- אל תכלול: מודעות מכירה, "מחפש דירה", פרסומות, ומודעות של נדל״ן **מסחרי**
  (משרד, חנות, מחסן, קליניקה, מגרש, מבנה תעשייה, "commercial", "office", "store").
  אם המודעה אינה למגורים - דלג עליה לגמרי.
- כלול רק מודעות שנמצאות ב"${city}". אם מודעה שייכת לעיר אחרת - דלג עליה.
  שים לב: דפים רבים מציגים "מודעות מקודמות" מערים אחרות. אלה אינן שייכות לרשימה.
- מחיר: מספר בלבד בשקלים לחודש. "5,500 ₪" -> 5500. אם אין מחיר - null.
- אל תמציא פרטים. שדה שלא מופיע בדף - null.
- אל תכלול מספרי טלפון בתיאור.
- description: משפט אחד קצר בלבד, עד 150 תווים. אל תעתיק את כל הטקסט מהמודעה.
- החזר לכל היותר 40 מודעות.
- postedText: העתק את תאריך הפרסום/עדכון בדיוק כפי שכתוב בדף. אל תמציא תאריך.
- entryText: תאריך הכניסה בדיוק כפי שכתוב ("מיידי", "1.10"). אם לא כתוב - null.
- אם אין בדף אף מודעת השכרה מתאימה - החזר listings: [].

תוכן הדף:
"""
${pageText}
"""`;
}

/** Everything past this is padding; keeps one call inside the free tier. */
const MAX_PAGE_CHARS = 60_000;

/**
 * A link to an individual listing, rather than navigation, a category or a
 * social button. Israeli boards all use one of these shapes, and every one
 * ends in an id or slug.
 */
function looksLikeListingLink(href: string): boolean {
  if (/^(?:#|mailto:|tel:|javascript:)/i.test(href)) return false;
  return /\/(?:item|ad|property|properties|listing|listings|viewad|details|single|p\d)/i.test(href)
    || /(?:id|itemId|modaaNum|adId)=\d+/i.test(href);
}

/**
 * Reduces a page to the text a reader would see. Scripts, styles and inline
 * CSS make up most of a modern listing page's bytes and none of its meaning,
 * and sending them would blow the token budget for no benefit.
 */
export function htmlToText(html: string, contentSelector?: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, head, nav, footer').remove();

  const root = contentSelector && $(contentSelector).length > 0 ? $(contentSelector) : $('body');

  const parts: string[] = [];
  root.find('*').addBack().contents().each((_, node) => {
    if (node.type !== 'text') return;
    const text = (node.data ?? '').replace(/\s+/g, ' ').trim();
    if (text) parts.push(text);
  });

  // Listing links carry the id we need, and text extraction alone loses them.
  //
  // Only links that look like a listing are included. Handing over a page's
  // whole navigation invited the model to emit an entry per link - one source
  // produced 79,000 characters of unparseable output for twelve flats.
  const links: string[] = [];
  const seenHrefs = new Set<string>();
  root.find('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!href || seenHrefs.has(href) || !looksLikeListingLink(href)) return;
    seenHrefs.add(href);

    const label = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 60);
    links.push(label ? `[${label}](${href})` : href);
  });

  // Photos are what make an alert glanceable, so the model is shown the
  // candidate image urls alongside the text and asked to pair them up.
  const images: string[] = [];
  root.find('img[src], img[data-src]').each((_, el) => {
    const src = $(el).attr('src') ?? $(el).attr('data-src') ?? '';
    const alt = $(el).attr('alt')?.replace(/\s+/g, ' ').trim().slice(0, 50) ?? '';
    if (src && !/^data:/.test(src) && !/logo|icon|sprite|avatar|placeholder/i.test(src)) {
      images.push(alt ? `[${alt}](${src})` : src);
    }
  });

  const body = parts.join(' | ');
  const linkBlock = links.length > 0 ? `\n\nLINKS:\n${links.slice(0, 60).join('\n')}` : '';
  const imageBlock = images.length > 0 ? `\n\nIMAGES:\n${images.slice(0, 40).join('\n')}` : '';
  return `${body}${linkBlock}${imageBlock}`.slice(0, MAX_PAGE_CHARS);
}

/** Returns [] when Gemini is unavailable or the page yields nothing usable. */
export async function extractListingsFromHtml(
  html: string,
  city: string,
  sourceName: string,
  contentSelector?: string,
): Promise<ExtractedListing[]> {
  if (!isGeminiConfigured()) return [];

  const pageText = htmlToText(html, contentSelector);
  if (pageText.length < 200) {
    logger.warn({ source: sourceName }, 'page had almost no text; skipping extraction');
    return [];
  }

  const json = await generateJson(buildPrompt(city, pageText), responseSchema, sourceName);
  if (!json) return [];

  const listings = parseExtracted(json);
  logger.debug(
    { source: sourceName, extracted: listings.length, chars: pageText.length },
    'gemini extraction complete',
  );
  return listings;
}
