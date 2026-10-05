import { z } from 'zod';
import { logger } from '../logger.js';
import {
  nullableBoolean,
  nullableString,
  positiveIntOrNull,
  positiveOrNull,
  stringList,
} from './fields.js';
import { generateJson, isGeminiConfigured, redactPhones } from './gemini.js';

/**
 * Turns free-text posts - Facebook groups, Telegram channels - into
 * structured listings, several posts per model call.
 *
 * One call per post was the original design, and it would have cost ~2,900
 * calls a day for four groups against a free tier of about a thousand.
 * Batching, plus callers only sending posts nobody has judged yet, keeps ten
 * groups under a hundred calls a day.
 */

export interface PostInput {
  /** The source's own post id; results are keyed by it. */
  id: string;
  text: string;
}

/** Posts per model call. Ten free-text posts answer in well under the 45 s call timeout. */
export const POSTS_PER_CALL = 10;

/** Free-text posts run long; this is plenty for a rental ad and bounds the prompt. */
const POST_TEXT_LIMIT = 2_000;

export const parsedPostSchema = z.object({
  index: z.number().int().nonnegative(),
  isRentalListing: z.boolean().nullish().transform((v) => v ?? false),
  /** "Looking for a flat" - reads like a listing to a careless parser, and dorin sent one as an alert. */
  isWantedPost: z.boolean().nullish().transform((v) => v ?? false),
  price: positiveIntOrNull,
  rooms: positiveOrNull,
  sqm: positiveOrNull,
  city: nullableString,
  neighborhood: nullableString,
  street: nullableString,
  floor: nullableString,
  propertyType: nullableString,
  amenities: stringList,
  isBroker: nullableBoolean,
  entryDateText: nullableString,
  summary: nullableString,
});

export type ParsedPost = z.infer<typeof parsedPostSchema>;

/** JSON Schema handed to the model; mirrors parsedPostSchema. */
const responseSchema = {
  type: 'object',
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The number in square brackets before the post' },
          isRentalListing: {
            type: 'boolean',
            description: 'true only for a residential apartment offered FOR RENT. Sales, roommate-wanted, adverts and chatter are false.',
          },
          isWantedPost: {
            type: 'boolean',
            description: 'true when the poster is LOOKING FOR a flat (מחפש/מחפשת דירה) rather than offering one',
          },
          price: { type: 'integer', nullable: true, description: 'Monthly rent in NIS, digits only' },
          rooms: { type: 'number', nullable: true, description: 'Room count, e.g. 3 or 3.5' },
          sqm: { type: 'integer', nullable: true, description: 'Size in square metres' },
          city: { type: 'string', nullable: true, description: 'City name in Hebrew' },
          neighborhood: { type: 'string', nullable: true, description: 'Neighbourhood in Hebrew' },
          street: { type: 'string', nullable: true, description: 'Street, with number if given' },
          floor: { type: 'string', nullable: true, description: 'e.g. "קומה 2" or "קומת קרקע"' },
          propertyType: {
            type: 'string',
            nullable: true,
            description: 'One of דירה, דירת גן, יחידת דיור, פנטהאוז, דופלקס, בית פרטי, סטודיו',
          },
          amenities: {
            type: 'array',
            items: { type: 'string' },
            description: 'Hebrew labels only, from: חניה, מעלית, מרפסת, ממ״ד, מחסן, מיזוג, מרוהטת, משופצת, חיות מחמד, גינה',
          },
          isBroker: {
            type: 'boolean',
            nullable: true,
            description: 'true if posted by an agency (תיווך/מתווך). false if it says ללא תיווך or is clearly a private owner.',
          },
          entryDateText: {
            type: 'string',
            nullable: true,
            description: 'The move-in date exactly as written, e.g. "מיידי", "1.10", "אמצע אוקטובר". null if none.',
          },
          summary: { type: 'string', nullable: true, description: 'One short Hebrew sentence describing the flat' },
        },
        required: ['index', 'isRentalListing', 'amenities'],
      },
    },
  },
  required: ['posts'],
};

export function buildPostsPrompt(city: string, texts: string[]): string {
  const blocks = texts.map((text, index) => `[${index}]\n"""\n${text}\n"""`).join('\n\n');
  return `אתה מנתח פוסטים מקבוצות פייסבוק ומערוצי טלגרם של שכירות דירות בישראל, עבור העיר "${city}".
לכל פוסט ממוספר החזר רשומה אחת עם אותו index. החזר JSON בלבד.

כללים:
- isRentalListing=true רק לדירת מגורים שמוצעת להשכרה.
- פוסט של מישהו שמחפש דירה ("מחפש/ת דירה", "דרושה דירה") הוא isWantedPost=true ו-isRentalListing=false.
- מכירה, שותפים, פרסומות, שאלות ושיחה - isRentalListing=false.
- rooms: "N חדרי שינה" / "N beds" הם חדרי שינה, כלומר N+1 חדרים.
- מחיר: מספר בלבד, בשקלים לחודש. "5,500₪" -> 5500. "5.5k" -> 5500. אם אין מחיר - null.
- אל תמציא פרטים שלא כתובים. מה שלא מופיע - null.
- entryDateText: תאריך הכניסה בדיוק כפי שכתוב. אם לא כתוב - null.
- summary: משפט אחד קצר בעברית, בלי מספרי טלפון ובלי שמות.

הפוסטים:
${blocks}`;
}

/**
 * Validates the model's reply one post at a time and maps each back to its
 * post id by index. A bad entry costs that post, never the batch.
 */
export function parseExtractedPosts(json: unknown, ids: string[]): Map<string, ParsedPost> {
  const results = new Map<string, ParsedPost>();
  const outer = z.object({ posts: z.array(z.unknown()).nullish() }).safeParse(json);
  if (!outer.success) return results;

  let rejected = 0;
  for (const raw of outer.data.posts ?? []) {
    const parsed = parsedPostSchema.safeParse(raw);
    const id = parsed.success ? ids[parsed.data.index] : undefined;
    if (!parsed.success || id === undefined) {
      rejected++;
      continue;
    }
    results.set(id, parsed.data);
  }
  if (rejected > 0) {
    logger.warn({ rejected, kept: results.size }, 'dropped unreadable extracted posts');
  }
  return results;
}

/**
 * Parses posts in batches. Phone numbers are stripped locally before any text
 * leaves the machine; callers re-attach them from the original text.
 * Returns only the posts the model answered for.
 */
export async function extractPosts(
  posts: PostInput[],
  city: string,
  label: string,
): Promise<Map<string, ParsedPost>> {
  const results = new Map<string, ParsedPost>();
  if (!isGeminiConfigured() || posts.length === 0) return results;

  for (let start = 0; start < posts.length; start += POSTS_PER_CALL) {
    const batch = posts.slice(start, start + POSTS_PER_CALL);
    const texts = batch.map((post) => redactPhones(post.text).redacted.slice(0, POST_TEXT_LIMIT));

    const json = await generateJson(buildPostsPrompt(city, texts), responseSchema, label);
    if (!json) continue;

    for (const [id, parsed] of parseExtractedPosts(json, batch.map((post) => post.id))) {
      results.set(id, parsed);
    }
  }

  logger.debug({ label, posts: posts.length, parsed: results.size }, 'post extraction complete');
  return results;
}
