import { z } from 'zod';
import {
  CURATED_CITIES,
  REGION_ALIASES,
  findCityByKey,
  mentionsCity,
  normalizePlace,
  searchCities,
} from '../core/cities.js';
import type { SavedSearch, SearchRequirements } from '../core/types.js';
import { logger } from '../logger.js';
import { nullableBoolean, nullableString, positiveIntOrNull, positiveOrNull, stringList } from './fields.js';
import { generateJson } from './gemini.js';

/**
 * A search described in a sentence - "3 חדרים במודיעין עד 6500 בלי תיווך" -
 * read into the wizard's fields, so setting up a search is one message and
 * one confirmation rather than six screens.
 */
export interface SearchDraft {
  cityKeys: string[];
  minRooms: number | null;
  maxRooms: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  areas: Record<string, string[]>;
  requirements?: SearchRequirements;
  /** What the model or the city table could not place, shown back to the owner. */
  unresolved: string[];
}

const replySchema = z.object({
  cities: stringList,
  minRooms: positiveOrNull,
  maxRooms: positiveOrNull,
  minPrice: positiveIntOrNull,
  maxPrice: positiveIntOrNull,
  areas: z
    .array(z.object({ city: nullableString, names: stringList }))
    .nullish()
    .transform((v) => v ?? []),
  amenities: stringList,
  privateOnly: nullableBoolean,
  minSqm: positiveOrNull,
  keywords: stringList,
  unclear: stringList,
});

const responseSchema = {
  type: 'object',
  properties: {
    cities: { type: 'array', items: { type: 'string' }, description: 'City names in Hebrew, as the person wrote them' },
    minRooms: { type: 'number', nullable: true },
    maxRooms: { type: 'number', nullable: true },
    minPrice: { type: 'integer', nullable: true, description: 'Monthly rent in NIS' },
    maxPrice: { type: 'integer', nullable: true, description: 'Monthly rent in NIS' },
    areas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          city: { type: 'string', nullable: true },
          names: { type: 'array', items: { type: 'string' }, description: 'Neighbourhoods or streets' },
        },
        required: ['names'],
      },
    },
    amenities: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only from: חניה, מעלית, מרפסת, ממ״ד, מחסן, מיזוג, מרוהטת, משופצת, חיות מחמד, גינה, מקלט (shelter or ממ״ק in the building)',
    },
    privateOnly: { type: 'boolean', nullable: true, description: 'true when they want no brokers (ללא תיווך)' },
    minSqm: { type: 'integer', nullable: true },
    keywords: { type: 'array', items: { type: 'string' }, description: 'Other must-haves as short words' },
    unclear: { type: 'array', items: { type: 'string' }, description: 'Parts of the request you could not map to any field' },
  },
  required: ['cities', 'amenities', 'keywords', 'unclear'],
};

function buildPrompt(text: string): string {
  // Examples, not the whole list: every city would add thousands of tokens to each call,
  // and whatever the model writes is resolved by searchCities anyway.
  const known = CURATED_CITIES.map((c) => c.name).join(', ');
  // Everyday region names the filter understands, so "north of the city" in
  // Rishon comes back as the alias that expands to real neighbourhoods.
  const regions = Object.entries(REGION_ALIASES)
    .map(([key, aliases]) => `${findCityByKey(key)?.name ?? key}: ${Object.keys(aliases).join(', ')}`)
    .join('; ');
  return `אתה ממיר בקשת חיפוש דירה להשכרה בעברית לשדות מובנים. החזר JSON בלבד.

כללים:
- ערים: השתמש בשמות מתוך הרשימה כשאפשר: ${known}. אם העיר לא ברשימה, כתוב אותה כפי שנכתבה.
- אזורים מוכרים לפי עיר: ${regions}. אם הבקשה מתארת אזור כזה במילים אחרות ("צפון העיר"), השתמש בשם המוכר.
- "3 חדרים" הוא minRooms=3 וגם maxRooms=3, אלא אם נכתב "לפחות"/"+" (אז רק minRooms) או טווח.
- "עד 6500" הוא maxPrice=6500. "מ-5000" הוא minPrice=5000. "5.5k" -> 5500.
- "בלי תיווך"/"ללא תיווך" הוא privateOnly=true.
- שכונות ורחובות נכנסים ל-areas עם העיר שלהם.
- keywords הן רק מילים שחייבות להופיע בטקסט המודעה (למשל "נוף", "מרפסת שמש"). תאריך כניסה, גמישות ותיאורים כלליים אינם keywords - שים אותם ב-unclear.
- מה שלא מובן או לא ניתן למיפוי - לתוך unclear, בקצרה.
- אל תמציא ערכים שלא נכתבו.

הבקשה:
"""
${text}
"""`;
}

/** Maps the model's reading onto the city table; null when no city resolves. */
export function parseSearchRequestJson(json: unknown): SearchDraft | null {
  const parsed = replySchema.safeParse(json);
  if (!parsed.success) return null;
  const reply = parsed.data;

  const cityKeys: string[] = [];
  const unresolved: string[] = [];
  for (const name of reply.cities) {
    const city = searchCities(name, 1)[0];
    if (!city) {
      unresolved.push(name);
      continue;
    }
    if (!cityKeys.includes(city.key)) cityKeys.push(city.key);
  }
  if (cityKeys.length === 0) return null;

  const areas: Record<string, string[]> = {};
  for (const area of reply.areas) {
    const city = area.city ? searchCities(area.city, 1)[0] : findCityByKey(cityKeys[0]!);
    if (!city || area.names.length === 0) continue;
    areas[city.key] = [...(areas[city.key] ?? []), ...area.names];
  }

  // The model tends to file a place under areas AND keywords. As a keyword it
  // would require the phrase in every ad's text, which no listing has.
  const areaNames = new Set(Object.values(areas).flat().map(normalizePlace));
  const keywords = reply.keywords.filter((keyword) => !areaNames.has(normalizePlace(keyword)));

  const requirements: SearchRequirements = {
    ...(reply.amenities.length > 0 ? { amenities: reply.amenities } : {}),
    ...(reply.privateOnly ? { brokers: 'private-only' as const } : {}),
    ...(reply.minSqm ? { minSqm: reply.minSqm } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
  };

  return {
    cityKeys,
    minRooms: reply.minRooms,
    maxRooms: reply.maxRooms,
    minPrice: reply.minPrice,
    maxPrice: reply.maxPrice,
    areas,
    ...(Object.keys(requirements).length > 0 ? { requirements } : {}),
    unresolved: [...unresolved, ...reply.unclear],
  };
}

/**
 * Reads a draft against what the chat already has saved.
 *
 * A message that names a city and nothing else - "גם ראשון" - is far more
 * often "and Rishon too" than a new search with no bounds, and the model is
 * told not to invent bounds the message did not state. So a bound-less draft
 * inherits the saved search's rooms, budget, areas and requirements and adds
 * its cities; a draft with any bound of its own stands alone.
 */
export function applyDraftToExisting(draft: SearchDraft, existing: SavedSearch | undefined): SearchDraft {
  const hasBounds =
    draft.minRooms !== null || draft.maxRooms !== null || draft.minPrice !== null || draft.maxPrice !== null;
  if (!existing || hasBounds) return draft;

  const cityKeys = [...existing.cityKeys, ...draft.cityKeys.filter((key) => !existing.cityKeys.includes(key))];
  const areas = { ...(existing.areas ?? {}), ...draft.areas };
  const requirements = draft.requirements ?? existing.requirements;

  return {
    ...draft,
    cityKeys,
    minRooms: existing.minRooms,
    maxRooms: existing.maxRooms,
    minPrice: existing.minPrice,
    maxPrice: existing.maxPrice,
    areas,
    ...(requirements ? { requirements } : {}),
  };
}

/**
 * Whether a stray message is worth a model call: it names a city, or it has
 * a number next to rooms or money. "היי" does not.
 */
export function looksLikeSearchRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (mentionsCity(trimmed)) return true;
  return /\d/.test(trimmed) && /חד|₪|שקל|ש"ח|ש״ח|\bעד\s*\d/.test(trimmed);
}

/** Reads a free-text request through the model; null when it cannot be read as a search. */
export async function parseSearchRequest(text: string): Promise<SearchDraft | null> {
  const json = await generateJson(buildPrompt(text), responseSchema, 'search-request');
  if (!json) return null;
  const draft = parseSearchRequestJson(json);
  logger.debug({ resolved: draft?.cityKeys, unresolved: draft?.unresolved }, 'search request read');
  return draft;
}
