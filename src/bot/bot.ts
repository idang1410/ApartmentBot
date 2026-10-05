import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, type Context } from 'grammy';
import { config } from '../config.js';
import type { HealthTracker } from '../core/health.js';
import type { Notifier } from '../core/notifier.js';
import type { PollCycle } from '../core/pollCycle.js';
import type { Scheduler } from '../core/scheduler.js';
import { KV_KEYS, type KvRepo } from '../db/kv.repo.js';
import type { ListingsRepo } from '../db/listings.repo.js';
import type { SearchesRepo } from '../db/searches.repo.js';
import type { UsersRepo } from '../db/users.repo.js';
import { isGeminiConfigured } from '../llm/gemini.js';
import { looksLikeSearchRequest, parseSearchRequest } from '../llm/parseSearchRequest.js';
import { logger } from '../logger.js';
import { AddWizard } from './addWizard.js';
import {
  HELP_TEXT,
  handleInvite,
  handleLatest,
  handleLatestCallback,
  handleList,
  handleMap,
  handleNow,
  handleUsers,
  handlePause,
  handleQuiet,
  handleRemoveCallback,
  handleRemovePrompt,
  handleStatus,
  ownerHint,
  type CommandDeps,
} from './commands.js';

export interface BotDeps {
  searches: SearchesRepo;
  listings: ListingsRepo;
  users: UsersRepo;
  kv: KvRepo;
  cycle: PollCycle;
  scheduler: Scheduler;
  health: HealthTracker;
  notifier: Notifier;
  /** Used to build invite deep links. */
  botUsername: string;
}

/** Created before its dependencies so the notifier can send through its api. */
export function createBot(): Bot {
  const bot = new Bot(config.telegramBotToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
  return bot;
}

export function registerHandlers(bot: Bot, deps: BotDeps): void {
  const wizard = new AddWizard(deps.searches, deps.cycle, deps.listings);
  const commandDeps: CommandDeps = { ...deps, startedAt: new Date() };

  bot.use(allowedUsersOnly(deps.users, deps.kv));

  bot.command('start', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    const joined = deps.users.get(chatId);
    // Alerts only speak when something is new, which reads as silence to a
    // person who just set up a search. Point at the command that shows the
    // market as it stands.
    const greeting = joined?.isOwner
      ? 'שלום! אני מנטר מודעות שכירות ומודיע לך על כל מודעה חדשה שמתאימה.\n' +
        'שלח /latest בכל רגע כדי לראות מה יש בשוק עכשיו.'
      : 'שלום! הצטרפת לבוט. הגדר חיפוש עם /add ותקבל התראה על כל מודעה חדשה שמתאימה.\n' +
        'אחרי שתגדיר חיפוש, /latest יראה לך מה יש בשוק עכשיו.';

    await ctx.reply(`${greeting}\n\n${HELP_TEXT}`, { parse_mode: 'HTML' });
  });

  bot.command('help', (ctx) => ctx.reply(HELP_TEXT, { parse_mode: 'HTML' }));
  bot.command('add', (ctx) => wizard.start(ctx));
  bot.command('list', (ctx) => handleList(ctx, commandDeps));
  bot.command('latest', (ctx) => handleLatest(ctx, commandDeps));
  bot.command('remove', (ctx) => handleRemovePrompt(ctx, commandDeps));
  bot.command('pause', (ctx) => handlePause(ctx, commandDeps, true));
  bot.command('resume', (ctx) => handlePause(ctx, commandDeps, false));
  bot.command('map', (ctx) => handleMap(ctx, commandDeps));
  bot.command('status', (ctx) => handleStatus(ctx, commandDeps));
  bot.command('now', (ctx) => handleNow(ctx, commandDeps));
  bot.command('quiet', (ctx) => handleQuiet(ctx, commandDeps, ctx.match ?? ''));
  bot.command('invite', (ctx) => handleInvite(ctx, commandDeps));
  bot.command('users', (ctx) => handleUsers(ctx, commandDeps));

  bot.command('cancel', async (ctx) => {
    if (ctx.chat) wizard.cancel(ctx.chat.id);
    await ctx.reply('בוטל.');
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    // Telegram shows a loading spinner on the button until this is answered.
    await ctx.answerCallbackQuery().catch(() => undefined);

    if (data.startsWith('add:')) {
      await wizard.handleCallback(ctx, data);
    } else if (data.startsWith('rm:')) {
      await handleRemoveCallback(ctx, commandDeps, data.slice(3));
    } else if (data.startsWith('latest:')) {
      await handleLatestCallback(ctx, commandDeps, data);
    }
  });

  // Only reaches free text that was not a command.
  bot.on('message:text', async (ctx) => {
    if (!ctx.chat) return;
    const text = ctx.message.text;

    if (wizard.isActive(ctx.chat.id)) {
      await wizard.handleText(ctx, text);
      return;
    }

    // A sentence that names a city or a budget is a search request: read it
    // and land on the confirmation screen with the fields filled in. Chatter
    // never reaches the model.
    if (isGeminiConfigured() && looksLikeSearchRequest(text)) {
      await ctx.reply('רגע, קורא את הבקשה…');
      const draft = await parseSearchRequest(text);
      if (draft) {
        await wizard.startFromDraft(ctx, draft);
        return;
      }
    }

    await ctx.reply(
      'לא הבנתי. אפשר לכתוב למשל: "3 חדרים במודיעין עד 6500 בלי תיווך", או /help לרשימת הפקודות.',
    );
  });

  bot.catch((error) => {
    logger.error({ err: error.error, update: error.ctx.update.update_id }, 'bot handler failed');
  });
}

/**
 * A short label for logs: the command word, or the kind of update. Never the
 * message body, which would put searches and personal text in the log file.
 */
function commandLabel(ctx: Context): string {
  const text = ctx.message?.text ?? '';
  const command = /^\/([A-Za-z0-9_]+)/.exec(text)?.[1];
  if (command) return `/${command}`;
  if (ctx.callbackQuery !== undefined) return 'button';
  if (text) return 'text';
  return 'update';
}

/**
 * Drops every update from a chat that has not been granted access.
 *
 * Three ways in, in order: the owner (from OWNER_CHAT_ID, or the first chat to
 * talk to a fresh bot), anyone already in the users table, and anyone opening
 * a valid one-time invite link. Everyone else is ignored without a reply, so
 * the bot never confirms it exists to someone guessing its name.
 */
function allowedUsersOnly(users: UsersRepo, kv: KvRepo) {
  return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    // Every update is recorded here, before the access decision. Without this
    // there is no way to tell "the message never arrived" from "it arrived and
    // was dropped" when someone reports the bot ignoring them.
    logger.info({ chatId, command: commandLabel(ctx) }, 'update received');

    const displayName =
      [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') ||
      ctx.from?.username ||
      null;

    // Bootstrap: adopt the configured owner, or claim a fresh bot.
    if (users.owner() === undefined) {
      const configured = config.ownerChatId;
      if (configured === undefined || chatId === configured) {
        users.add(chatId, displayName, true);
        kv.set(KV_KEYS.ownerChatId, String(chatId));
        logger.info({ chatId }, 'registered bot owner');
        return next();
      }
    }

    if (users.isAllowed(chatId)) return next();

    // An invite arrives as a /start payload from a t.me deep link.
    const payload = /^\/start\s+(\S+)/.exec(ctx.message?.text ?? '')?.[1];
    if (payload && users.redeemInvite(payload, chatId, displayName)) {
      logger.info({ chatId }, 'user joined via invite');
      return next();
    }

    // Warn, not debug: at the default log level a denied update would leave
    // no trace at all, hiding both a stranger probing and a real user who was
    // never granted access.
    logger.warn({ chatId, command: commandLabel(ctx) }, 'ignored update from a chat without access');
  };
}
