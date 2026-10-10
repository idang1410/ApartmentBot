import { createBot, registerHandlers } from './bot/bot.js';
import { config } from './config.js';
import { HealthTracker } from './core/health.js';
import { Geocoder } from './core/geocode.js';
import { Notifier } from './core/notifier.js';
import { PollCycle } from './core/pollCycle.js';
import { checkRemovedYad2 } from './core/removedCheck.js';
import { Scheduler } from './core/scheduler.js';
import { openDatabase } from './db/database.js';
import { KvRepo } from './db/kv.repo.js';
import { ListingsRepo } from './db/listings.repo.js';
import { SearchesRepo } from './db/searches.repo.js';
import { UsersRepo } from './db/users.repo.js';
import { logger } from './logger.js';
import { buildAdapters } from './sources/index.js';
import { startMapServer } from './web/mapServer.js';

const db = openDatabase(config.dbPath);

const searches = new SearchesRepo(db);
const listings = new ListingsRepo(db);
const users = new UsersRepo(db);
const kv = new KvRepo(db);
const health = new HealthTracker();

// Sources that read free text ask the store before spending a model call.
const adapters = buildAdapters(
  { find: (source, id) => listings.findStored(source, id) },
  config.enabledSources,
  kv,
);

// The bot exists before its handlers so the notifier can hold its api while
// the handlers hold the cycle that the notifier feeds.
const bot = createBot();
const notifier = new Notifier(bot.api, listings, searches, kv);
const cycle = new PollCycle(adapters, searches, listings, kv, notifier, health);
const scheduler = new Scheduler(
  cycle,
  adapters.some((a) => a.name === 'yad2') ? () => checkRemovedYad2({ searches, listings, kv, notifier }) : undefined,
);

function main(): void {
  logger.info(
    { pollMinutes: config.pollMinutes, searches: searches.list().length },
    'apartment bot starting',
  );

  scheduler.start();
  startMapServer({ listings, kv, geocoder: new Geocoder(db), port: config.mapPort });

  // bot.start() settles only once polling stops, so it must not be awaited.
  bot
    .start({
      onStart: (info) => {
        // Handlers are registered here because invite links embed the bot's
        // username, which Telegram only tells us once polling begins.
        registerHandlers(bot, {
          searches,
          listings,
          users,
          kv,
          cycle,
          scheduler,
          health,
          notifier,
          botUsername: info.username,
        });
        logger.info({ username: info.username }, 'telegram polling started');
      },
    })
    .catch(handleStartupFailure);
}

/**
 * A rejected token is a configuration mistake, not a transient fault. Saying so
 * plainly matters because the service supervisor would otherwise restart the
 * process every few seconds forever, burying the cause in stack traces.
 */
function handleStartupFailure(error: unknown): never {
  const code = (error as { error_code?: number }).error_code;

  if (code === 401) {
    logger.fatal(
      'Telegram rejected the bot token (401 Unauthorized). ' +
        'Check TELEGRAM_BOT_TOKEN in .env against the token @BotFather gave you.',
    );
  } else if (code === 409) {
    logger.fatal(
      'Another instance of this bot is already polling (409 Conflict). ' +
        'Stop the other copy - check for the ApartmentBot service as well as this terminal.',
    );
  } else {
    logger.fatal({ err: error }, 'telegram polling could not start');
  }

  scheduler.stop();
  db.close();
  process.exit(1);
}

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  scheduler.stop();
  void bot.stop().finally(() => {
    db.close();
    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Anything reaching these handlers is a bug rather than an expected failure,
// so exit and let the Windows service restart from a known-good state.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled rejection, exiting for restart');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception, exiting for restart');
  process.exit(1);
});

main();
