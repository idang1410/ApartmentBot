import { InlineKeyboard } from 'grammy';
import { findCityByKey } from '../core/cities.js';
import { classifyMatch, describeSearch, nearMissReason } from '../core/filter.js';
import { describeComparison, type MarketComparison } from '../core/marketStats.js';
import { STATUSES, statusCallback, statusLabel, type TrackStatus } from '../core/tracking.js';
import type { Listing, ListingCopy, SavedSearch } from '../core/types.js';

export const SOURCE_LABELS: Record<string, string> = {
  homeless: 'הומלס',
  madlan: 'מדלן',
  realta: 'Realta',
  yad2: 'יד2',
  facebook: 'פייסבוק',
  telegram: 'טלגרם',
};

/**
 * A search's one-line description, safe for an HTML-mode message. Since
 * keywords joined the description it carries the owner's own text, and a
 * typed "<" once made Telegram reject the whole confirmation screen.
 */
export function searchTitle(search: SavedSearch): string {
  return escapeHtml(describeSearch(search));
}

/**
 * Which cities a search is narrowed to, and which it covers whole.
 *
 * Escaped like `searchTitle`, since a street can be typed by hand.
 *
 * /list used to print the title alone, so a search covering a city end to end
 * looked exactly like one filtered to three streets. That is not cosmetic:
 * seen-ness is keyed per chat, so a forgotten whole-city search claims every
 * listing before a narrowed one is consulted, and the narrow filter appears
 * to do nothing. Saying "כל העיר" out loud is how that search gets spotted.
 */
export function describeSearchScope(search: SavedSearch): string {
  return search.cityKeys
    .map((key) => ({ city: findCityByKey(key), chosen: search.areas?.[key] ?? [] }))
    .filter((entry) => entry.city !== undefined)
    .map(
      (entry) =>
        `${escapeHtml(entry.city!.name)}: ` +
        (entry.chosen.length > 0 ? entry.chosen.map(escapeHtml).join(', ') : 'כל העיר'),
    )
    .join(' · ');
}

/** Telegram HTML mode: only these characters need escaping. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Telegram rejects photo captions over 1024 characters. */
const CAPTION_LIMIT = 1024;
const DESCRIPTION_LIMIT = 320;
const COPIES_LIMIT = 5;

/**
 * Builds the message for one listing, in the shape people actually scan:
 * a labelled block of facts, then features, then the ad text.
 *
 * Kept within Telegram's caption limit by trimming the description, which is
 * the only field with unbounded length.
 */
export function formatListing(
  listing: Listing,
  _searchName?: string,
  comparison?: MarketComparison | null,
  copies: ListingCopy[] = [],
): string {
  const lines: string[] = [];

  // Price first and alone: it is the field that decides whether the rest is
  // worth reading.
  const price =
    listing.price === null ? 'מחיר לא צוין' : `<b>${listing.price.toLocaleString('en-US')} ₪</b> לחודש`;
  lines.push(`💰 ${price}`);

  // How it compares turns a number into a judgement - the difference between
  // "6,300 ₪" and "6,300 ₪, which is 18% under the going rate here".
  const verdict = comparison ? describeComparison(comparison) : null;
  if (verdict) lines.push(verdict);

  // The city is always shown. One search can cover several cities, so it is
  // not implied by the search any more - without it a Modi'in flat and a
  // Rishon LeZion flat look identical. It sits after a dot so the street and
  // neighbourhood still read as one phrase.
  const local = [listing.address, listing.neighborhood]
    .filter((value): value is string => Boolean(value))
    // Some sources repeat the city as the neighbourhood; saying it twice reads
    // like a mistake.
    .filter((value, index, all) => value !== listing.city && all.indexOf(value) === index)
    .map(escapeHtml);

  const city = listing.city ? escapeHtml(listing.city) : '';
  const place = local.length > 0 && city ? `${local.join(', ')} · ${city}` : (local.join(', ') || city);
  if (place) lines.push(`📍 ${place}`);

  const specs = [
    listing.propertyType ? escapeHtml(listing.propertyType) : null,
    listing.rooms !== null ? `${listing.rooms} חד׳` : null,
    listing.sqm !== undefined ? `${listing.sqm} מ״ר` : null,
    listing.floor
      ? `${escapeHtml(listing.floor)}${listing.floorsTotal ? ` מתוך ${listing.floorsTotal}` : ''}`
      : null,
  ].filter(Boolean);
  if (specs.length > 0) lines.push(`🏠 ${specs.join(' · ')}`);

  // When you can move in decides whether a flat is worth a call this week.
  const entry = listing.entryText ?? (listing.entryDate ? formatDate(listing.entryDate) : null);
  if (entry) lines.push(`📅 כניסה: ${escapeHtml(entry)}`);

  if (listing.amenities.length > 0) {
    lines.push(`🔑 ${listing.amenities.map(escapeHtml).join(' · ')}`);
  }

  if (listing.phone) lines.push(`📞 ${escapeHtml(listing.phone)}`);

  if (copies.length > 0) lines.push('', ...formatCopies(listing, copies));

  const descriptionAt = lines.length;

  // One quiet footer: how old it is and where it came from. Both change what
  // the listing is worth - a Facebook post and an agency ad are not alike.
  const footer = [
    listing.postedAt ? formatPostedAt(listing.postedAt) : null,
    listing.isBroker === true ? 'תיווך' : listing.isBroker === false ? 'ללא תיווך' : null,
    escapeHtml(listing.originalSource ?? SOURCE_LABELS[listing.source] ?? listing.source),
  ].filter(Boolean);
  lines.push('', `<i>${footer.join(' · ')}</i>`);

  // The description gives way first, so the links above are never cut mid-tag.
  if (listing.description) {
    const room = Math.min(DESCRIPTION_LIMIT, CAPTION_LIMIT - lines.join('\n').length - 2);
    if (room > 0) lines.splice(descriptionAt, 0, '', escapeHtml(truncate(listing.description, room)));
  }

  return truncate(lines.join('\n'), CAPTION_LIMIT);
}

/**
 * Other ads for the same flat, one line each: board, agent or private, price
 * against this card's, and a link; a copy the owner tracked shows its status.
 * Sure matches come first, then cheapest.
 */
export function formatCopies(listing: Listing, copies: ListingCopy[]): string[] {
  const sorted = [...copies].sort(
    (a, b) => Number(a.kind === 'maybe') - Number(b.kind === 'maybe') || (a.listing.price ?? Infinity) - (b.listing.price ?? Infinity),
  );
  return [
    '👯 אותה דירה מפורסמת גם ב:',
    ...sorted.slice(0, COPIES_LIMIT).map(({ listing: copy, kind, status }) => {
      const diff = copy.price !== null && listing.price !== null ? copy.price - listing.price : 0;
      const price =
        copy.price === null
          ? null
          : `${copy.price.toLocaleString('en-US')} ₪` +
            (diff === 0 ? '' : ` (${diff > 0 ? '+' : '−'}${Math.abs(diff).toLocaleString('en-US')})`);
      const parts = [
        status ? statusLabel(status).split(' ')[0] : null,
        (kind === 'maybe' ? 'אולי: ' : '') + escapeHtml(copy.originalSource ?? SOURCE_LABELS[copy.source] ?? copy.source),
        copy.isBroker === true ? 'תיווך' : copy.isBroker === false ? 'פרטי' : null,
        price,
        kind === 'maybe' && copy.floor ? escapeHtml(copy.floor) : null,
        `<a href="${escapeHtml(copy.url)}">מודעה</a>`,
      ].filter(Boolean);
      return `• ${parts.join(' · ')}`;
    }),
  ];
}

/**
 * The buttons under a listing: the ad itself, a map when there is a street,
 * and WhatsApp when the ad published a number - the two things a person does
 * next after deciding a flat is interesting. With a tracking id, the status
 * buttons follow, the current one ticked.
 */
export function listingKeyboard(
  listing: Listing,
  tracking?: { id: number; status: TrackStatus | null },
): InlineKeyboard {
  const keyboard = new InlineKeyboard().url('פתח מודעה ↗', listing.url);

  if (listing.address) {
    const place = [listing.address, listing.city].filter(Boolean).join(' ');
    keyboard.url('🗺 מפה', `https://maps.google.com/?q=${encodeURIComponent(place)}`);
  }

  const whatsapp = whatsappUrl(listing.phone);
  if (whatsapp) keyboard.row().url('WhatsApp 💬', whatsapp);

  if (tracking) {
    for (const [index, { code, label }] of STATUSES.entries()) {
      if (index % 3 === 0) keyboard.row();
      keyboard.text(`${code === tracking.status ? '✓ ' : ''}${label}`, statusCallback(tracking.id, code));
    }
  }

  return keyboard;
}

function whatsappUrl(phone: string | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  const international = digits.startsWith('972')
    ? digits
    : digits.startsWith('0')
      ? `972${digits.slice(1)}`
      : null;
  if (!international || international.length < 11) return null;
  const greeting = encodeURIComponent('שלום, ראיתי את המודעה על הדירה. האם היא עדיין רלוונטית?');
  return `https://wa.me/${international}?text=${greeting}`;
}

function formatDate(date: Date): string {
  return `${date.getDate()}.${date.getMonth() + 1}.${date.getFullYear()}`;
}

/** How long ago reads better than a date for something posted this week. */
export function formatPostedAt(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return 'פורסם היום';
  if (days === 1) return 'פורסם אתמול';
  if (days < 7) return `לפני ${days} ימים`;
  if (days < 14) return 'לפני שבוע';
  return `לפני ${Math.floor(days / 7)} שבועות`;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * The header for a price-drop alert. Says where the new price leaves the
 * listing relative to the search: a flat that is cheaper but still over the
 * cap must not read as if it now fits, and one that just dropped into the
 * band deserves saying so.
 */
export function priceDropHeader(
  listing: Listing,
  previousPrice: number,
  search?: SavedSearch,
): string {
  const price = listing.price ?? previousPrice;
  const saved = previousPrice - price;
  const lines = [
    `📉 <b>ירידת מחיר</b> · ${previousPrice.toLocaleString('en-US')} ₪ → ` +
      `<b>${price.toLocaleString('en-US')} ₪</b> (−${saved.toLocaleString('en-US')} ₪)`,
  ];

  if (search) {
    const now = classifyMatch(listing, search);
    const before = classifyMatch({ ...listing, price: previousPrice }, search);
    if (now === 'near') {
      const reason = nearMissReason(listing, search);
      lines.push(`🤏 <b>כמעט מתאים</b>${reason ? ` · ${escapeHtml(reason)}` : ''}`);
    } else if (now === 'exact' && before === 'near') {
      lines.push('✅ עכשיו בטווח שלך');
    }
  }

  return lines.join('\n');
}

/**
 * Newest first, with undated listings - most boards publish no date - after
 * the dated ones in their original order. Returns a new array.
 */
export function newestFirst(listings: Listing[]): Listing[] {
  return [...listings].sort((a, b) => {
    const at = a.postedAt?.getTime();
    const bt = b.postedAt?.getTime();
    if (at === undefined && bt === undefined) return 0;
    if (at === undefined) return 1;
    if (bt === undefined) return -1;
    return bt - at;
  });
}

/**
 * Telegram fetches the photo itself, so it must be a plain https image URL.
 */
export function pickPhoto(listing: Listing): string | undefined {
  const candidate = listing.imageUrls[0];
  if (!candidate) return undefined;
  return /^https:\/\//.test(candidate) ? candidate : undefined;
}
