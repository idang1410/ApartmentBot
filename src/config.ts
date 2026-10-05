import 'dotenv/config';
import { z } from 'zod';

/**
 * An unset variable in .env arrives as "" rather than undefined, and
 * z.coerce.number() turns "" into 0 - which would make the owner check compare
 * against chat id 0 and silently drop every message. Blanks become undefined
 * first so optional really means optional.
 */
const blankAsUndefined = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((value) => {
    if (typeof value === 'string' && value.trim() === '') return undefined;
    return value;
  }, inner);

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(20, 'looks too short to be a bot token'),
  OWNER_CHAT_ID: blankAsUndefined(z.coerce.number().int().optional()),
  GEMINI_API_KEY: blankAsUndefined(z.string().optional()),
  POLL_MINUTES: blankAsUndefined(z.coerce.number().int().min(1).max(1440).default(15)),
  DB_PATH: blankAsUndefined(z.string().default('./data/apartment.db')),
  LOG_LEVEL: blankAsUndefined(
    z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  ),
  // A profile directory alone does not prove a live Facebook session - merely
  // launching the browser creates one - so the source is off until this is
  // set explicitly after `npm run fb-login` succeeds.
  FACEBOOK_ENABLED: blankAsUndefined(z.enum(['0', '1']).default('0')),
  // Which boards to read, comma separated (e.g. "yad2,madlan"). Unset means
  // all of them. See `selectSources` in sources/index.ts for why this is a
  // setting and not a code edit.
  SOURCES: blankAsUndefined(z.string().optional()),
  MAP_PORT: blankAsUndefined(z.coerce.number().int().min(1).max(65535).default(8787)),
});

/**
 * Reads the SOURCES setting: a comma separated list of adapter names, or
 * nothing for all of them.
 *
 * Kept as configuration rather than deleted code because "which boards are
 * worth reading" is a judgement that changes. The owner cut the list to Yad2
 * and Madlan after a source delivered six commercial office units as
 * apartments; putting the rest back is an .env edit, not a release.
 *
 * Lives here rather than beside the adapters because config must not import
 * them - they import config.
 */
export function selectSources(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const names = raw
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
  return names.length > 0 ? names : undefined;
}

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error(`Invalid configuration in .env:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  /** Undefined until the owner runs /start once; see bot/bot.ts. */
  ownerChatId: env.OWNER_CHAT_ID,
  geminiApiKey: env.GEMINI_API_KEY,
  pollMinutes: env.POLL_MINUTES,
  dbPath: env.DB_PATH,
  logLevel: env.LOG_LEVEL,
  facebookEnabled: env.FACEBOOK_ENABLED === '1',
  /** Boards to read; undefined means every one that is registered. */
  enabledSources: selectSources(env.SOURCES),
  mapPort: env.MAP_PORT,
  /** Poll cycles are spread by this fraction so requests are not clockwork. */
  jitterFraction: 0.2,
  /** Individual messages per cycle before collapsing the rest into a summary. */
  maxMessagesPerCycle: 8,
} as const;
