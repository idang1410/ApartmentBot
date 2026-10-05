/**
 * Registers the bot's command menu and descriptions with Telegram.
 *
 * The command list is what Telegram shows in its "/" menu, so it is the first
 * thing a new user sees. Run after changing the commands.
 */
import { Bot } from 'grammy';
import { config } from '../src/config.js';

const bot = new Bot(config.telegramBotToken);

await bot.api.setMyCommands([
  { command: 'add', description: 'הוספת חיפוש חדש' },
  { command: 'list', description: 'החיפושים השמורים שלי' },
  { command: 'latest', description: 'מה יש בשוק כרגע' },
  { command: 'map', description: 'מפת הדירות שהתאימו' },
  { command: 'status', description: 'מצב המערכת והמקורות' },
  { command: 'now', description: 'הרצת סריקה עכשיו' },
  { command: 'remove', description: 'מחיקת חיפוש' },
  { command: 'pause', description: 'השהיית התראות' },
  { command: 'resume', description: 'חידוש התראות' },
  { command: 'quiet', description: 'שעות שקט' },
  { command: 'invite', description: 'הזמנת חבר' },
  { command: 'help', description: 'עזרה' },
]);

await bot.api.setMyShortDescription('מוצא לך דירות להשכרה ברגע שהן מתפרסמות');

await bot.api.setMyDescription(
    'אני סורק את כל לוחות הדירות בישראל - יד2, מדלן, הומלס, קומו ועוד - ' +
    'ושולח לך התראה על כל דירה חדשה שמתאימה לחיפוש שלך, כולל ירידות מחיר. ' +
    'שלח /add כדי להתחיל.',
);

console.log('commands and descriptions registered');
process.exit(0);
