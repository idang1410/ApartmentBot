import type { Api } from 'grammy';
import { config } from '../config.js';
import { escapeHtml, formatListing, listingKeyboard, pickPhoto, priceDropHeader } from '../bot/format.js';
import { nearMissReason } from './filter.js';
import { KV_KEYS, type KvRepo } from '../db/kv.repo.js';
import type { ListingsRepo } from '../db/listings.repo.js';
import type { SearchesRepo } from '../db/searches.repo.js';
import { logger } from '../logger.js';
import { sleep } from '../util/http.js';
import { isWithinQuietHours, parseQuietHours } from '../util/time.js';
import { compareToMarket } from './marketStats.js';
import type { Listing } from './types.js';

/**
 * Sends listings to the owner and records that they were sent.
 *
 * Nothing is ever dropped: during quiet hours listings stay queued in the
 * database with notified_at NULL and are flushed by the first cycle that runs
 * outside the window.
 */
export class Notifier {
  /**
   * Everything currently on the market, refreshed each cycle. Kept in memory
   * rather than stored: it is only used to say how a listing compares with its
   * neighbours at the moment the alert goes out.
   */
  private market: Listing[] = [];

  constructor(
    private readonly api: Api,
    private readonly listings: ListingsRepo,
    private readonly searches: SearchesRepo,
    private readonly kv: KvRepo,
  ) {}

  setMarket(listings: Listing[]): void {
    this.market = listings;
  }

  private ownerChatId(): number | undefined {
    const stored = this.kv.get(KV_KEYS.ownerChatId);
    return config.ownerChatId ?? (stored ? Number(stored) : undefined);
  }

  /**
   * Where a search's alerts go. Searches created before the bot supported more
   * than one person carry no chat id, so they fall back to the owner.
   */
  private chatFor(searchId: number | null): number | undefined {
    if (searchId === null) return this.ownerChatId();
    const chatId = this.searches.getById(searchId)?.chatId;
    return chatId && chatId !== 0 ? chatId : this.ownerChatId();
  }

  isQuietNow(): boolean {
    const raw = this.kv.get(KV_KEYS.quietHours);
    if (!raw) return false;
    const window = parseQuietHours(raw);
    return window !== null && isWithinQuietHours(window);
  }

  /** Sends everything queued, unless it is quiet hours. Returns count sent. */
  async flushPending(): Promise<number> {
    if (this.isQuietNow()) return 0;

    const pending = this.listings.pending();
    if (pending.length === 0) return 0;

    // The cap is per person: one user's busy search must not eat another's
    // allowance for the cycle.
    const sentPerChat = new Map<number, number>();
    let sent = 0;

    for (const item of pending) {
      // The row carries its own chat; searches predating multi-user have 0 and
      // fall back to the owner.
      const chatId = item.chatId !== 0 ? item.chatId : this.chatFor(item.searchId);
      if (chatId === undefined) {
        logger.warn('listing has no chat to go to; it stays queued');
        continue;
      }

      const already = sentPerChat.get(chatId) ?? 0;
      if (already >= config.maxMessagesPerCycle) continue;

      const search = item.searchId === null ? undefined : this.searches.getById(item.searchId);

      // A near miss says so up front, with the bound it missed, so the owner
      // can tell at a glance whether the search is drawn too tight.
      const reason = item.matchKind === 'near' && search ? nearMissReason(item.listing, search) : null;
      const header = reason ? `🤏 <b>כמעט מתאים</b> · ${escapeHtml(reason)}` : undefined;

      // Rejected or taken since it was queued.
      if (this.listings.isClosed(item.listing, chatId)) {
        this.listings.markNotified(item.listing.source, item.listing.sourceId, chatId);
        continue;
      }

      const delivered = await this.sendListing(chatId, item.listing, search?.name, header);
      if (delivered) {
        this.listings.markNotified(item.listing.source, item.listing.sourceId, chatId);
        sentPerChat.set(chatId, already + 1);
        sent++;
      }
      await sleep(1_000); // stay well inside Telegram's per-chat rate limit
    }

    // Whatever was capped keeps its NULL notified_at and goes out next cycle.
    for (const [chatId, count] of sentPerChat) {
      const remaining = pending.filter((p) => this.chatFor(p.searchId) === chatId).length - count;
      if (remaining > 0) {
        await this.sendText(chatId, `…ועוד ${remaining} מודעות בתור. הן יישלחו בסבב הבא.`);
      }
    }

    return sent;
  }

  /**
   * Reports a listing whose asking price has fallen. Sent immediately rather
   * than queued, because a price drop is time-sensitive and there are never
   * many in one cycle.
   */
  async sendPriceDrop(listing: Listing, previousPrice: number, searchId?: number): Promise<void> {
    const chatId = this.chatFor(searchId ?? null);
    if (chatId === undefined || this.isQuietNow()) return;

    // Drops are detected for near misses too, so the header must say whether
    // the flat now fits the search or is merely a cheaper near miss.
    const search = searchId === undefined ? undefined : this.searches.getById(searchId);
    await this.sendListing(chatId, listing, undefined, priceDropHeader(listing, previousPrice, search));
    await sleep(800);
  }

  /**
   * Sends a listing on demand without touching its notified state, so /review
   * and /tracked can show it again without affecting the alert stream.
   */
  async sendPreview(listing: Listing, chatId: number, header?: string): Promise<void> {
    await this.sendListing(chatId, listing, undefined, header);
    await sleep(600);
  }

  /** Operational messages - source failures and recoveries - owner only. */
  async notifyOwner(text: string): Promise<void> {
    const chatId = this.ownerChatId();
    if (chatId === undefined) return;
    await this.sendText(chatId, text);
  }

  async notifyChat(chatId: number, text: string): Promise<void> {
    await this.sendText(chatId, text);
  }

  private async sendListing(
    chatId: number,
    listing: Listing,
    searchName: string | undefined,
    header?: string,
  ): Promise<boolean> {
    const body = formatListing(
      listing,
      searchName,
      compareToMarket(listing, this.market),
      this.listings.copiesOf(listing, chatId),
    );
    const caption = header ? `${header}\n\n${body}` : body;
    const id = this.listings.track(listing, chatId);
    const keyboard = listingKeyboard(listing, { id, status: this.listings.tracked(id, chatId)?.status ?? null });
    const photo = pickPhoto(listing);

    try {
      if (photo) {
        await this.api.sendPhoto(chatId, photo, {
          caption,
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } else {
        await this.api.sendMessage(chatId, caption, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
          link_preview_options: { is_disabled: true },
        });
      }
      return true;
    } catch (error) {
      // A photo URL the source published can be dead or blocked; the listing
      // itself is still worth sending, so retry once as plain text.
      if (photo) {
        logger.warn({ err: error, url: listing.url }, 'photo send failed, retrying as text');
        try {
          await this.api.sendMessage(chatId, caption, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
            link_preview_options: { is_disabled: true },
          });
          return true;
        } catch (retryError) {
          logger.error({ err: retryError, url: listing.url }, 'listing send failed');
          return false;
        }
      }
      logger.error({ err: error, url: listing.url }, 'listing send failed');
      return false;
    }
  }

  private async sendText(chatId: number, text: string): Promise<void> {
    try {
      await this.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error({ err: error }, 'owner message failed');
    }
  }
}
