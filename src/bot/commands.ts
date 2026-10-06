import { InlineKeyboard, type Context } from 'grammy';
import { config } from '../config.js';
import { describeSearch, nearMissReason } from '../core/filter.js';
import type { HealthTracker } from '../core/health.js';
import type { Notifier } from '../core/notifier.js';
import type { PollCycle } from '../core/pollCycle.js';
import type { Scheduler } from '../core/scheduler.js';
import type { Listing, SavedSearch } from '../core/types.js';
import { STATUSES, parseStatusCallback, statusLabel, type TrackStatus } from '../core/tracking.js';
import { describeSearchScope, escapeHtml, listingKeyboard, searchTitle } from './format.js';
import {
  CARDS_PAGE,
  DIGEST_PAGE,
  LatestSessions,
  formatDigest,
  latestKeyboard,
  orderSnapshot,
  type SearchSnapshot,
} from './latest.js';
import { REVIEW_DAYS, reviewQueue, type ReviewItem } from './review.js';
import { KV_KEYS, type KvRepo } from '../db/kv.repo.js';
import { sqliteNow, type ListingsRepo } from '../db/listings.repo.js';
import type { SearchesRepo } from '../db/searches.repo.js';
import type { UsersRepo } from '../db/users.repo.js';
import { lanAddress, MAP_DAYS, mapTokenFor } from '../web/mapServer.js';
import { formatDuration, formatQuietHours, parseQuietHours } from '../util/time.js';

export interface CommandDeps {
  searches: SearchesRepo;
  listings: ListingsRepo;
  users: UsersRepo;
  kv: KvRepo;
  cycle: PollCycle;
  scheduler: Scheduler;
  health: HealthTracker;
  notifier: Notifier;
  botUsername: string;
  startedAt: Date;
}

export const HELP_TEXT = [
  '<b>הפקודות שלי</b>',
  '',
  '/add - הוספת חיפוש חדש (עיר, חדרים, תקציב)',
  'או פשוט כתוב: "3 חדרים במודיעין עד 6500 בלי תיווך"',
  '/list - כל החיפושים השמורים',
  '/latest - מה יש בשוק כרגע (גם אם כבר נשלח)',
  '/remove - מחיקת חיפוש',
  '/map - מפה של הדירות שהתאימו ב-14 הימים האחרונים',
  '/tracked - דירות שסימנת (/tracked all כולל לא רלוונטיות)',
  '/review - מעבר על הדירות שהתאימו ב-30 הימים האחרונים לסימון (/review new רק מה שלא סימנת)',
  'תשובה (reply) להתראה נשמרת כהערה, ומספר טלפון בה נשמר לדירה',
  '/pause · /resume - השהיה וחידוש של כל ההתראות',
  '/status - מצב המערכת והמקורות',
  '/now - הרצת סבב סריקה עכשיו',
  '/quiet 23:00-07:30 - שעות שקט (/quiet off לביטול)',
  '/invite - קישור הזמנה לחבר (בעלים בלבד)',
  '/help - ההודעה הזו',
].join('\n');

/** The chat this update came from; every command is scoped to its own chat. */
function chatOf(ctx: Context): number {
  return ctx.chat?.id ?? 0;
}

export async function handleList(ctx: Context, deps: CommandDeps): Promise<void> {
  const searches = deps.searches.list(chatOf(ctx));
  if (searches.length === 0) {
    await ctx.reply('אין חיפושים שמורים. שלח /add כדי להוסיף אחד.');
    return;
  }

  // The scope line is not decoration. Seen-ness is per chat, so a search
  // covering a whole city claims every listing before a narrower one is
  // consulted - a forgotten one silently cancels a street filter saved later.
  // Printing "כל העיר" is what makes that search findable.
  const lines = searches.map(
    (s) =>
      `${s.active ? '🟢' : '⏸'} <b>${s.id}</b>. ${searchTitle(s)}\n` +
      `<i>📍 ${describeSearchScope(s)}</i>`,
  );
  await ctx.reply(['<b>החיפושים שלך</b>', '', ...lines].join('\n'), { parse_mode: 'HTML' });
}

export async function handleRemovePrompt(ctx: Context, deps: CommandDeps): Promise<void> {
  const searches = deps.searches.list(chatOf(ctx));
  if (searches.length === 0) {
    await ctx.reply('אין מה למחוק.');
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const s of searches) keyboard.text(describeSearch(s), `rm:${s.id}`).row();
  keyboard.text('ביטול', 'rm:cancel');

  await ctx.reply('איזה חיפוש למחוק?', { reply_markup: keyboard });
}

export async function handleRemoveCallback(
  ctx: Context,
  deps: CommandDeps,
  value: string,
): Promise<void> {
  if (value === 'cancel') {
    await ctx.editMessageText('בוטל.');
    return;
  }

  const id = Number(value);
  const search = deps.searches.getById(id);
  // Scoped to the caller: one person must not be able to delete another's.
  if (!search || !deps.searches.belongsTo(id, chatOf(ctx))) {
    await ctx.editMessageText('החיפוש כבר לא קיים.');
    return;
  }

  // Clear the queue before the search, or anything already collected for it
  // keeps arriving after the owner has been told it is gone.
  const dropped = deps.listings.discardPending(id);
  deps.searches.remove(id);

  await ctx.editMessageText(
    `נמחק: ${describeSearch(search)}` +
      (dropped > 0 ? `\nביטלתי גם ${dropped} התראות שהיו בהמתנה.` : ''),
  );
}

export async function handlePause(ctx: Context, deps: CommandDeps, paused: boolean): Promise<void> {
  deps.kv.setBoolean(KV_KEYS.globalPaused, paused);
  await ctx.reply(
    paused
      ? '⏸ השהיתי את ההתראות. שלח /resume כדי לחדש.'
      : '▶️ ההתראות פעילות שוב.',
  );
}

export async function handleStatus(ctx: Context, deps: CommandDeps): Promise<void> {
  const paused = deps.kv.getBoolean(KV_KEYS.globalPaused);
  const lastCycle = deps.kv.get(KV_KEYS.lastCycleAt);
  const next = deps.scheduler.getNextRunAt();
  const quiet = deps.kv.get(KV_KEYS.quietHours);

  const lines = [
    `<b>מצב</b>: ${paused ? '⏸ מושהה' : '🟢 פעיל'}`,
    `זמן פעילות: ${formatDuration(Date.now() - deps.startedAt.getTime())}`,
    `חיפושים: ${deps.searches.listActive().length} פעילים מתוך ${deps.searches.list().length}`,
    `מודעות שנרשמו: ${deps.listings.total(chatOf(ctx))} (24 שעות אחרונות: ${deps.listings.countSince(
      sqliteNow(new Date(Date.now() - 86_400_000)),
      chatOf(ctx),
    )})`,
    `סבב אחרון: ${lastCycle ? new Date(lastCycle).toLocaleString('he-IL') : 'עוד לא רץ'}`,
    `סבב הבא: ${next ? next.toLocaleTimeString('he-IL') : '-'}${
      deps.scheduler.isRunning() ? ' (רץ עכשיו)' : ''
    }`,
    `שעות שקט: ${quiet ?? 'כבויות'}`,
    '',
    '<b>מקורות</b>',
  ];

  const health = deps.health.all();
  if (health.length === 0) {
    lines.push('עוד לא רץ סבב.');
  } else {
    for (const h of health) {
      if (h.consecutiveFailures === 0) {
        lines.push(`✅ ${h.name} - תקין`);
      } else {
        const since = h.failingSince?.toLocaleTimeString('he-IL') ?? '?';
        const backoff = h.backoffCycles > 0 ? `, ממתין ${h.backoffCycles} סבבים` : '';
        lines.push(`⚠️ ${h.name} - ${h.consecutiveFailures} כשלונות מאז ${since}${backoff}`);
      }
    }
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

export async function handleQuiet(ctx: Context, deps: CommandDeps, argument: string): Promise<void> {
  const arg = argument.trim();

  if (!arg) {
    const current = deps.kv.get(KV_KEYS.quietHours);
    await ctx.reply(
      current
        ? `שעות שקט: ${current}\nלביטול: /quiet off`
        : 'שעות שקט כבויות. להפעלה: /quiet 23:00-07:30',
    );
    return;
  }

  if (arg === 'off') {
    deps.kv.delete(KV_KEYS.quietHours);
    await ctx.reply('שעות שקט בוטלו.');
    return;
  }

  const window = parseQuietHours(arg);
  if (!window) {
    await ctx.reply('פורמט לא תקין. דוגמה: /quiet 23:00-07:30');
    return;
  }

  deps.kv.set(KV_KEYS.quietHours, formatQuietHours(window));
  await ctx.reply(
    `שעות שקט: ${formatQuietHours(window)}\n` +
      'בזמן הזה אמשיך לסרוק, ואשלח הכל ברגע שהחלון נגמר.',
  );
}

/**
 * A chat's last /latest results, kept ten minutes so the paging buttons work
 * without sweeping every source again.
 */
const latestSessions = new LatestSessions(10 * 60_000);

/**
 * Shows what is on the market for each search right now, as a paged digest.
 *
 * When nothing matches it shows the closest listings instead, because "no
 * alerts" is ambiguous - it can mean a quiet market or a search that is too
 * narrow, and only the near-misses tell the two apart.
 */
export async function handleLatest(ctx: Context, deps: CommandDeps): Promise<void> {
  const chat = chatOf(ctx);
  const searches = deps.searches.list(chat);
  if (searches.length === 0) {
    await ctx.reply('אין חיפושים שמורים. שלח /add כדי להוסיף אחד.');
    return;
  }

  await ctx.reply('בודק מה יש בשוק כרגע…');

  // Each city is fetched once for all of this chat's searches.
  const snapshots = await deps.cycle.previewAll(searches);
  const entries: SearchSnapshot[] = searches.map((search) => ({
    search,
    ...(snapshots.get(search.id) ?? { matching: [], near: [], all: [] }),
  }));
  latestSessions.set(chat, entries);

  // Comparisons ("18% under the going rate") against what is on offer now,
  // not against whatever the last poll cycle happened to see.
  deps.notifier.setMarket(entries.flatMap((entry) => entry.all));

  for (const [index, entry] of entries.entries()) {
    await sendDigestPage(ctx, deps, entry, index, 0);
  }
}

/** Handles the paging buttons under a /latest digest: latest:<digest|cards>:<search>:<offset>. */
export async function handleLatestCallback(ctx: Context, deps: CommandDeps, data: string): Promise<void> {
  const [, mode, searchIndex, offset] = data.split(':');
  const entries = latestSessions.get(chatOf(ctx));
  const entry = entries?.[Number(searchIndex)];
  if (!entry) {
    await ctx.reply('התוצאות התיישנו. שלח /latest שוב.');
    return;
  }
  if (mode === 'cards') {
    await sendCardsPage(ctx, deps, entry, Number(searchIndex), Number(offset) || 0);
  } else {
    await sendDigestPage(ctx, deps, entry, Number(searchIndex), Number(offset) || 0);
  }
}

async function sendDigestPage(
  ctx: Context,
  deps: CommandDeps,
  entry: SearchSnapshot,
  searchIndex: number,
  offset: number,
): Promise<void> {
  const chat = chatOf(ctx);
  const alreadySent = (l: Listing) => deps.listings.wasNotified(l.source, l.sourceId, chat);
  const { search, matching, near, all } = entry;
  const ordered = orderSnapshot(entry, alreadySent);
  const fresh = matching.filter((l) => !alreadySent(l)).length;

  const title = `<b>${searchTitle(search)}</b>\n`;

  if (ordered.length === 0) {
    // Nothing even close: show what the city has, ordered by how far off the
    // price is, so "too narrow" and "nothing on the market" look different.
    const closest = [...all]
      .filter((l) => l.price !== null)
      .sort((a, b) => priceDistance(a.price!, search) - priceDistance(b.price!, search))
      .slice(0, CARDS_PAGE);
    await ctx.reply(
      title +
        `אין כרגע מודעה שתואמת, מתוך ${all.length} מודעות בעיר.` +
        (closest.length > 0
          ? `\nהכי קרובות לטווח שלך:\n\n${formatDigest(closest, { offset: 0, pageSize: CARDS_PAGE, alreadySent, nearMiss: () => null })}`
          : ''),
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
    );
    return;
  }

  const counts =
    `${matching.length} מתאימות` +
    (near.length > 0 ? `, ${near.length} כמעט` : '') +
    ` · מתוך ${all.length} בעיר` +
    (fresh > 0 ? `\n${fresh} עוד לא נשלחו אליך (✓ = כבר נשלח)` : '');

  await ctx.reply(
    `${title}${counts}\n\n` +
      formatDigest(ordered, {
        offset,
        pageSize: DIGEST_PAGE,
        alreadySent,
        nearMiss: (l) => (near.includes(l) ? nearMissReason(l, search) : null),
      }),
    {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: latestKeyboard({ searchIndex, offset, pageSize: DIGEST_PAGE, total: ordered.length }),
    },
  );
}

/** The same page as photo cards, for when a line is not enough to decide. */
async function sendCardsPage(
  ctx: Context,
  deps: CommandDeps,
  entry: SearchSnapshot,
  searchIndex: number,
  offset: number,
): Promise<void> {
  const chat = chatOf(ctx);
  const alreadySent = (l: Listing) => deps.listings.wasNotified(l.source, l.sourceId, chat);
  const ordered = orderSnapshot(entry, alreadySent);

  for (const listing of ordered.slice(offset, offset + CARDS_PAGE)) {
    const reason = entry.near.includes(listing) ? nearMissReason(listing, entry.search) : null;
    const header = reason
      ? `🤏 <i>כמעט מתאים - ${escapeHtml(reason)}</i>`
      : alreadySent(listing)
        ? '<i>כבר נשלח קודם</i>'
        : '<i>חדש - עוד לא נשלח</i>';
    await deps.notifier.sendPreview(listing, chat, header);
  }

  const next = offset + CARDS_PAGE;
  if (next < ordered.length) {
    await ctx.reply(`…ועוד ${ordered.length - next}.`, {
      reply_markup: new InlineKeyboard().text('🖼 עוד כרטיסים', `latest:cards:${searchIndex}:${next}`),
    });
  }
}

/** How far a price sits outside the search bounds; 0 when inside. */
function priceDistance(
  price: number,
  search: Pick<SavedSearch, 'minPrice' | 'maxPrice'>,
): number {
  if (search.maxPrice !== null && price > search.maxPrice) return price - search.maxPrice;
  if (search.minPrice !== null && price < search.minPrice) return search.minPrice - price;
  return 0;
}

/** One alert card to send again, with the line shown above it. */
interface Card {
  listing: Listing;
  header?: string;
}

/**
 * A chat's last /review or /tracked list, keyed "<command>:<chat>". Paging walks
 * this list rather than a fresh one, so a flat marked on one page does not
 * shift the next page.
 */
const cardSessions = new Map<string, Card[]>();

/** Sends the chat's stored matches again as alert cards, to go over and mark. */
export async function handleReview(ctx: Context, deps: CommandDeps, argument: string): Promise<void> {
  const chat = chatOf(ctx);
  const onlyUnmarked = argument.trim() === 'new';
  const searches = deps.searches.list(chat).filter((s) => s.active);
  const queue = reviewQueue(deps.listings, searches, chat, onlyUnmarked);
  if (queue.length === 0) {
    await ctx.reply(
      onlyUnmarked
        ? `אין דירות שעוד לא סימנת מ-${REVIEW_DAYS} הימים האחרונים.`
        : `אין דירות שהתאימו ב-${REVIEW_DAYS} הימים האחרונים.`,
    );
    return;
  }
  const cards = queue.map(({ listing, matchKind, search }: ReviewItem) => {
    const reason = matchKind === 'near' ? nearMissReason(listing, search) : null;
    return { listing, ...(reason ? { header: `🤏 <b>כמעט מתאים</b> · ${escapeHtml(reason)}` } : {}) };
  });
  cardSessions.set(`review:${chat}`, cards);
  await sendCardList(ctx, deps, 'review', cards, 0);
}

/** The "more" button under a /review or /tracked page: <command>:<offset>. */
export async function handleCardsCallback(ctx: Context, deps: CommandDeps, data: string): Promise<void> {
  const [command, offset] = data.split(':');
  const cards = cardSessions.get(`${command}:${chatOf(ctx)}`);
  if (!cards) {
    await ctx.reply(`הרשימה התיישנה. שלח /${command} שוב.`);
    return;
  }
  await sendCardList(ctx, deps, command!, cards, Number(offset) || 0);
}

async function sendCardList(
  ctx: Context,
  deps: CommandDeps,
  command: string,
  queue: Card[],
  offset: number,
): Promise<void> {
  const page = queue.slice(offset, offset + CARDS_PAGE);
  for (const { listing, header } of page) {
    await deps.notifier.sendPreview(listing, chatOf(ctx), header);
  }

  const shown = offset + page.length;
  if (page.length === 0) {
    await ctx.reply('אין עוד דירות לסקירה.');
  } else if (shown < queue.length) {
    await ctx.reply(`הצגתי ${shown} מתוך ${queue.length}`, {
      reply_markup: new InlineKeyboard().text('עוד ▶', `${command}:${shown}`),
    });
  } else {
    await ctx.reply(`הצגתי ${shown} מתוך ${queue.length}. זה הכל.`);
  }
}

/** A link to this chat's map, served from this machine on the local network. */
export async function handleMap(ctx: Context, deps: CommandDeps): Promise<void> {
  const host = lanAddress();
  if (!host) {
    await ctx.reply('לא מצאתי כתובת ברשת המקומית למחשב של הבוט.');
    return;
  }
  const url = `http://${host}:${config.mapPort}/?t=${mapTokenFor(deps.kv, chatOf(ctx))}`;
  await ctx.reply(
    `🗺 מפת הדירות שהתאימו לחיפושים שלך ב-${MAP_DAYS} הימים האחרונים:\n\n${url}\n\n` +
      'הקישור עובד רק מרשת ה-Wi-Fi של המחשב שמריץ את הבוט. הוא אישי - לא לשתף.',
    { link_preview_options: { is_disabled: true } },
  );
}

/** Creates a share link. Only the owner may hand out access. */
export async function handleInvite(ctx: Context, deps: CommandDeps): Promise<void> {
  const me = deps.users.get(chatOf(ctx));
  if (!me?.isOwner) {
    await ctx.reply('רק הבעלים של הבוט יכול להזמין משתמשים.');
    return;
  }

  const code = deps.users.createInvite();
  const link = `https://t.me/${deps.botUsername}?start=${code}`;

  await ctx.reply(
    'קישור הזמנה חד-פעמי:\n\n' +
      `${link}\n\n` +
      'מי שילחץ עליו יצטרף לבוט ויוכל להגדיר חיפושים משלו. ' +
      'ההתראות שלו יגיעו אליו בלבד, והחיפושים שלך נשארים פרטיים.',
    { link_preview_options: { is_disabled: true } },
  );
}

/** Everyone with access, owner only. */
export async function handleUsers(ctx: Context, deps: CommandDeps): Promise<void> {
  const me = deps.users.get(chatOf(ctx));
  if (!me?.isOwner) {
    await ctx.reply('רק הבעלים של הבוט יכול לראות את רשימת המשתמשים.');
    return;
  }

  const lines = deps.users.list().map((u) => {
    const searches = deps.searches.list(u.chatId).length;
    return `${u.isOwner ? '👑' : '👤'} ${escapeHtml(u.name ?? String(u.chatId))} - ${searches} חיפושים`;
  });
  const pending = deps.users.pendingInvites();

  await ctx.reply(
    ['<b>משתמשים</b>', '', ...lines, '', `הזמנות שלא נוצלו: ${pending}`].join('\n'),
    { parse_mode: 'HTML' },
  );
}

/** A status button under an alert: st:<tracking id>:<status>. */
export async function handleStatusCallback(ctx: Context, deps: CommandDeps, data: string): Promise<void> {
  const parsed = parseStatusCallback(data);
  const tracked = parsed && deps.listings.tracked(parsed.id, chatOf(ctx));
  if (!parsed || !tracked) {
    await ctx.answerCallbackQuery({ text: 'הדירה לא נמצאה.' }).catch(() => undefined);
    return;
  }
  deps.listings.setStatus(parsed.id, chatOf(ctx), parsed.status);
  await ctx.answerCallbackQuery({ text: `סומן: ${statusLabel(parsed.status)}` }).catch(() => undefined);
  await ctx
    .editMessageReplyMarkup({ reply_markup: listingKeyboard(tracked.listing, parsed) })
    .catch(() => undefined);
}

/**
 * Saves a text reply to an alert as a note on that flat. The alert is
 * recognised by the status buttons on it. Returns false for any other message.
 */
export async function handleTrackedReply(ctx: Context, deps: CommandDeps): Promise<boolean> {
  const replied = ctx.message?.reply_to_message;
  const text = ctx.message?.text;
  if (!replied || !text || replied.from?.id !== ctx.me.id) return false;

  const id = replied.reply_markup?.inline_keyboard
    .flat()
    .map((button) => ('callback_data' in button ? parseStatusCallback(button.callback_data) : null))
    .find((parsed) => parsed !== null)?.id;
  if (id === undefined) return false;

  const saved = deps.listings.addNote(id, chatOf(ctx), text);
  await ctx.reply(
    saved ? `📝 ההערה נשמרה${saved.phone ? ` · 📞 ${saved.phone}` : ''}` : 'הדירה לא נמצאה.',
    { reply_parameters: { message_id: ctx.message!.message_id } },
  );
  return true;
}

/** Tracked flats grouped by status; rejected ones only with `all`. */
export async function handleTracked(ctx: Context, deps: CommandDeps, argument: string): Promise<void> {
  const tracked = deps.listings.listTracked(chatOf(ctx), argument.trim() === 'all');
  if (tracked.length === 0) {
    await ctx.reply('עוד לא סימנת דירות. לחץ על כפתור סטטוס מתחת להתראה.');
    return;
  }

  // Grouped by status in the order of the buttons; flats with only notes come last.
  const order = (status: TrackStatus | null) => {
    const index = STATUSES.findIndex((st) => st.code === status);
    return index === -1 ? STATUSES.length : index;
  };
  const cards = [...tracked]
    .sort((a, b) => order(a.status) - order(b.status))
    .map(({ listing, status, phone, notes }) => {
      const contact = phone ?? listing.phone;
      const note = notes.at(-1)?.text;
      const header = [
        `<b>${status ? statusLabel(status) : '📝 עם הערות'}</b>`,
        contact ? `📞 ${escapeHtml(contact)}` : null,
        note ? `📝 ${escapeHtml(note.length > 120 ? `${note.slice(0, 119)}…` : note)}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      return { listing, header };
    });
  cardSessions.set(`tracked:${chatOf(ctx)}`, cards);
  await sendCardList(ctx, deps, 'tracked', cards, 0);
}

export async function handleNow(ctx: Context, deps: CommandDeps): Promise<void> {
  if (deps.scheduler.isRunning()) {
    await ctx.reply('כבר רץ סבב כרגע.');
    return;
  }
  await ctx.reply('מריץ סבב סריקה…');
  await deps.scheduler.runNow();
  await ctx.reply('הסבב הסתיים. /status לפרטים.');
}

export function ownerHint(): string {
  return config.ownerChatId === undefined
    ? '\n\n(רשמתי את הצ׳אט הזה כבעלים. אפשר לקבע אותו גם ב-.env)'
    : '';
}
