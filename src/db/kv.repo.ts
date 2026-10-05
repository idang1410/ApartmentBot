import type { Db } from './database.js';

/** Small runtime settings the owner changes from Telegram, e.g. quiet hours. */
export class KvRepo {
  constructor(private readonly db: Db) {}

  get(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
      .run(key, value, value);
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  /** The first key under `prefix` whose value is `value`. */
  findKey(prefix: string, value: string): string | undefined {
    const row = this.db
      .prepare('SELECT key FROM kv WHERE substr(key, 1, ?) = ? AND value = ? LIMIT 1')
      .get(prefix.length, prefix, value) as { key: string } | undefined;
    return row?.key;
  }

  getBoolean(key: string): boolean {
    return this.get(key) === '1';
  }

  setBoolean(key: string, value: boolean): void {
    this.set(key, value ? '1' : '0');
  }
}

export const KV_KEYS = {
  quietHours: 'quiet_hours',
  globalPaused: 'global_paused',
  lastCycleAt: 'last_cycle_at',
  ownerChatId: 'owner_chat_id',
  /** Followed by a chat id; the secret in that chat's map link. */
  mapTokenPrefix: 'map_token:',
} as const;
