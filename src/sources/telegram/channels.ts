import type { CityEntry } from '../../core/types.js';

export interface TelegramChannel {
  /** The public username from t.me/<name>; also the dedupe namespace, so keep it stable. */
  name: string;
  /** Shown in the alert footer when the page itself gives no title. */
  title: string;
}

/**
 * Public Telegram channels to read, per city key.
 *
 * Read through https://t.me/s/<name>, the server-rendered preview that needs
 * no account and breaks no terms - unlike Facebook. Discovery on 2026-09-08
 * (`npm run telegram-probe`) found one live Rishon channel and none for
 * Modi'in, whose private market is on Facebook groups; add a Modi'in channel
 * here if one ever appears.
 */
export const TELEGRAM_CHANNELS: Record<string, TelegramChannel[]> = {
  rishon: [
    // Nester's per-city feed: private, no-broker rentals, several posts a day.
    { name: 'nester_rent_rishonlezion', title: 'ראשון לציון דירות להשכרה ללא תיווך' },
  ],
  modiin: [],
  'tel-aviv': [
    { name: 'nester_rent_telaviv', title: 'תל אביב דירות להשכרה ללא תיווך' },
  ],
};

export function channelsForCity(city: CityEntry): TelegramChannel[] {
  return TELEGRAM_CHANNELS[city.key] ?? [];
}
