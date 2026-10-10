import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerHandlers, type BotDeps } from '../src/bot/bot.js';
import type { Notifier } from '../src/core/notifier.js';
import { statusCallback } from '../src/core/tracking.js';
import { BlockedError, type Listing } from '../src/core/types.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { KvRepo } from '../src/db/kv.repo.js';
import { ListingsRepo } from '../src/db/listings.repo.js';
import { SearchesRepo } from '../src/db/searches.repo.js';
import { UsersRepo } from '../src/db/users.repo.js';
import type { ParsedPost } from '../src/llm/extractPosts.js';
import { bareListing, classifyLink, messageLink, readLink } from '../src/sources/linkReader.js';

vi.mock('../src/util/http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/util/http.js')>()),
  fetchText: vi.fn(),
}));
vi.mock('../src/llm/extractPosts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/llm/extractPosts.js')>()),
  extractPosts: vi.fn(),
}));
vi.mock('../src/sources/linkReader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sources/linkReader.js')>();
  return { ...actual, readLink: vi.fn(actual.readLink) };
});

const { fetchText } = await import('../src/util/http.js');
const { extractPosts } = await import('../src/llm/extractPosts.js');

describe('link classification', () => {
  it.each([
    [
      'https://www.facebook.com/groups/telaviv/posts/1234567890/?comment_id=5',
      { kind: 'facebook-post', source: 'facebook', sourceId: '1234567890', url: 'https://www.facebook.com/groups/telaviv/posts/1234567890/' },
    ],
    [
      'https://m.facebook.com/groups/101/permalink/222/',
      { kind: 'facebook-post', source: 'facebook', sourceId: '222', url: 'https://www.facebook.com/groups/101/posts/222/' },
    ],
    [
      'https://www.facebook.com/marketplace/item/987654/?ref=share',
      { kind: 'marketplace', source: 'facebook-marketplace', sourceId: '987654', url: 'https://www.facebook.com/marketplace/item/987654/' },
    ],
    [
      'https://www.yad2.co.il/realestate/item/tel-aviv-area/8sb6wj2k?opened-from=feed',
      { kind: 'page', source: 'yad2', sourceId: '8sb6wj2k', url: 'https://www.yad2.co.il/realestate/item/8sb6wj2k' },
    ],
    [
      'https://www.madlan.co.il/listings/AbC123x',
      { kind: 'page', source: 'madlan', sourceId: 'AbC123x', url: 'https://www.madlan.co.il/listings/AbC123x' },
    ],
    [
      'https://www.homeless.co.il/rent/viewad,123.aspx#top',
      { kind: 'page', source: 'homeless.co.il', sourceId: 'https://www.homeless.co.il/rent/viewad,123.aspx', url: 'https://www.homeless.co.il/rent/viewad,123.aspx' },
    ],
  ])('classifies %s', (link, expected) => {
    expect(classifyLink(link)).toMatchObject(expected);
  });

  it('rejects what is not a web link', () => {
    expect(classifyLink('not a link')).toBeNull();
    expect(classifyLink('ftp://x.com/a')).toBeNull();
  });

  it('finds a link only in a message that is nothing else', () => {
    expect(messageLink('  https://x.co.il/a?b=1 \n')).toBe('https://x.co.il/a?b=1');
    expect(messageLink('look at https://x.co.il/a')).toBeNull();
    expect(messageLink('3 חדרים בתל אביב')).toBeNull();
  });
});

const parsed: ParsedPost = {
  index: 0,
  isRentalListing: false,
  isWantedPost: false,
  price: 6_500,
  rooms: 3,
  sqm: null,
  city: 'חיפה',
  neighborhood: null,
  street: 'הרצל 5',
  floor: null,
  propertyType: null,
  amenities: [],
  isBroker: null,
  entryDateText: null,
  summary: 'דירה למכירה',
};

describe('reading a link', () => {
  const target = classifyLink('https://www.yad2.co.il/realestate/item/abc123')!;
  const page = classifyLink('https://www.madlan.co.il/listings/abc123')!;

  beforeEach(() => {
    vi.mocked(extractPosts).mockReset();
    vi.mocked(fetchText).mockReset();
  });

  it('keeps only the link when the page cannot be read', async () => {
    vi.mocked(fetchText).mockRejectedValueOnce(new Error('HTTP 403'));
    const { listing, rental } = await readLink(target, 'תל אביב יפו');
    expect(rental).toBeNull();
    expect(listing).toEqual({
      source: 'yad2',
      sourceId: 'abc123',
      url: 'https://www.yad2.co.il/realestate/item/abc123',
      price: null,
      rooms: null,
      city: 'תל אביב יפו',
      amenities: [],
      imageUrls: [],
      originalSource: 'יד2',
    });
  });

  it('reads a Yad2 ad from the gateway, with no model', async () => {
    vi.mocked(fetchText).mockResolvedValueOnce(
      readFileSync(join(import.meta.dirname, 'fixtures', 'yad2-item-tel-aviv.json'), 'utf8'),
    );
    const { listing, rental } = await readLink(target, '');
    expect(fetchText).toHaveBeenCalledWith(
      'https://gw.yad2.co.il/realestate-item/abc123',
      expect.objectContaining({ headers: expect.objectContaining({ Origin: 'https://www.yad2.co.il' }) }),
    );
    expect(extractPosts).not.toHaveBeenCalled();
    expect(rental).toBe(true);
    expect(listing).toMatchObject({ source: 'yad2', price: 10_000, rooms: 3 });
  });

  it('keeps only the link when the gateway answers a challenge', async () => {
    vi.mocked(fetchText).mockRejectedValueOnce(new BlockedError('yad2', 'Radware challenge'));
    expect(await readLink(target, '')).toEqual({ listing: bareListing(target, ''), rental: null });
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it('keeps only the link when the model gives no answer', async () => {
    vi.mocked(fetchText).mockResolvedValueOnce('<html><body>דירה</body></html>');
    vi.mocked(extractPosts).mockResolvedValueOnce(new Map());
    expect((await readLink(page, '')).listing.price).toBeNull();
  });

  it('keeps what was parsed from a page the model says is not a rental', async () => {
    vi.mocked(fetchText).mockResolvedValueOnce('<html><body>דירה למכירה</body></html>');
    vi.mocked(extractPosts).mockResolvedValueOnce(new Map([['abc123', parsed]]));
    const { listing, rental } = await readLink(page, 'תל אביב יפו');
    expect(rental).toBe(false);
    expect(listing).toMatchObject({ source: 'madlan', price: 6_500, rooms: 3, city: 'חיפה', address: 'הרצל 5' });
  });
});

describe('link messages to the bot', () => {
  const CHAT = 1; // OWNER_CHAT_ID in the test environment
  const BOT_ID = 99;
  let db: Db;
  let listings: ListingsRepo;
  let bot: Bot;
  let replies: string[];
  const sendPreview = vi.fn(async (_listing: Listing, _chat: number, _header?: string) => undefined);

  function message(text: string, extra: object = {}): Update {
    return {
      update_id: 1,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: CHAT, type: 'private', first_name: 'o' },
        from: { id: CHAT, is_bot: false, first_name: 'o' },
        text,
        ...extra,
      },
    } as Update;
  }

  beforeEach(() => {
    vi.mocked(readLink).mockReset();
    sendPreview.mockClear();
    db = openDatabase(':memory:');
    listings = new ListingsRepo(db);
    replies = [];
    bot = new Bot('000000:test', {
      botInfo: { id: BOT_ID, is_bot: true, first_name: 'b', username: 'b' } as Bot['botInfo'],
    });
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === 'sendMessage') replies.push((payload as { text: string }).text);
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: CHAT, type: 'private' } } } as never;
    });
    const deps: BotDeps = {
      searches: new SearchesRepo(db),
      listings,
      users: new UsersRepo(db),
      kv: new KvRepo(db),
      cycle: {} as never,
      scheduler: {} as never,
      health: {} as never,
      notifier: { sendPreview } as unknown as Notifier,
      botUsername: 'b',
    };
    registerHandlers(bot, deps);
  });

  it('reads a new link in the background and tracks it as interested', async () => {
    const link = 'https://www.yad2.co.il/realestate/item/abc123';
    const listing = bareListing(classifyLink(link)!, '');
    vi.mocked(readLink).mockResolvedValueOnce({ listing, rental: null });

    await bot.handleUpdate(message(link));
    expect(replies).toEqual(['קורא את המודעה…']);
    await vi.waitFor(() => expect(sendPreview).toHaveBeenCalled());

    expect(sendPreview.mock.calls[0]![2]).toContain('לא הצלחתי לקרוא');
    expect(listings.listTracked(CHAT, false)).toMatchObject([{ status: 'interested', listing: { sourceId: 'abc123' } }]);
  });

  it('shows a link already stored without reading it again', async () => {
    const stored: Listing = {
      source: 'madlan', sourceId: 'X1', url: 'https://www.madlan.co.il/listings/X1',
      price: 5_000, rooms: 2, city: 'תל אביב יפו', amenities: [], imageUrls: [],
    };
    const searchId = new SearchesRepo(db).create({
      chatId: CHAT, name: 't', cityKeys: ['tel-aviv'], cityName: 'תל אביב יפו',
      minRooms: null, maxRooms: null, minPrice: null, maxPrice: null,
    }).id;
    listings.seedAsSeen([stored], searchId, CHAT + 1);

    await bot.handleUpdate(message('/track https://madlan.co.il/listings/X1', {
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    }));

    expect(readLink).not.toHaveBeenCalled();
    expect(sendPreview).toHaveBeenCalledWith(stored, CHAT, undefined);
    const tracked = listings.findTracked('madlan', 'X1', CHAT);
    expect(tracked?.price).toBe(5_000);

    // A second time finds the tracked copy and keeps its status.
    const id = listings.track(stored, CHAT);
    listings.setStatus(id, CHAT, 'visited');
    await bot.handleUpdate(message('https://madlan.co.il/listings/X1'));
    expect(listings.tracked(id, CHAT)?.status).toBe('visited');
    expect(sendPreview).toHaveBeenCalledTimes(2);
  });

  it('saves the first status tapped on a card', async () => {
    const id = listings.track(
      { source: 'yad2', sourceId: 'a', url: 'https://x/a', price: 1, rooms: 1, city: 'c', amenities: [], imageUrls: [] },
      CHAT,
    );
    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: 'q',
        chat_instance: 'c',
        from: { id: CHAT, is_bot: false, first_name: 'o' },
        message: { message_id: 5, date: 0, chat: { id: CHAT, type: 'private', first_name: 'o' } },
        data: statusCallback(id, 'rejected'),
      },
    } as Update);
    expect(listings.tracked(id, CHAT)?.status).toBe('rejected');
  });

  it('saves a link sent as a reply to an alert as a note', async () => {
    const id = listings.track(
      { source: 'yad2', sourceId: 'a', url: 'https://x/a', price: 1, rooms: 1, city: 'c', amenities: [], imageUrls: [] },
      CHAT,
    );
    await bot.handleUpdate(message('https://www.yad2.co.il/realestate/item/zzz', {
      reply_to_message: {
        message_id: 5,
        date: 0,
        chat: { id: CHAT, type: 'private', first_name: 'o' },
        from: { id: BOT_ID, is_bot: true, first_name: 'b' },
        text: 'card',
        reply_markup: { inline_keyboard: [[{ text: 's', callback_data: statusCallback(id, 'interested') }]] },
      },
    }));

    expect(readLink).not.toHaveBeenCalled();
    expect(listings.tracked(id, CHAT)?.notes.map((n) => n.text)).toEqual(['https://www.yad2.co.il/realestate/item/zzz']);
  });
});
