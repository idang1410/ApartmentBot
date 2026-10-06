/** Where the owner stands with one flat, in the order a hunt moves through them. */
export const STATUSES = [
  { code: 'interested', label: '⭐ מעניין' },
  { code: 'contacted', label: '📞 בקשר' },
  { code: 'visit_scheduled', label: '📅 נקבע ביקור' },
  { code: 'visited', label: '👀 ביקרתי' },
  { code: 'rejected', label: '❌ לא רלוונטי' },
  { code: 'taken', label: '🚫 נלקח' },
] as const;

export type TrackStatus = (typeof STATUSES)[number]['code'];

/** A flat in one of these is never alerted again, from any board. */
export const CLOSED_STATUSES: readonly TrackStatus[] = ['rejected', 'taken'];

/** Longest note kept; anything longer is cut. */
export const NOTE_LIMIT = 500;

export interface TrackNote {
  /** SQLite UTC timestamp, "YYYY-MM-DD HH:MM:SS". */
  at: string;
  text: string;
}

/** What the owner recorded about one flat. */
export interface Tracking {
  id: number;
  status: TrackStatus | null;
  phone: string | null;
  notes: TrackNote[];
}

export function isTrackStatus(value: unknown): value is TrackStatus {
  return STATUSES.some((s) => s.code === value);
}

export function statusLabel(status: TrackStatus): string {
  return STATUSES.find((s) => s.code === status)!.label;
}

/** Callback data for a status button: `st:<tracking id>:<status>`, well under Telegram's 64 bytes. */
export function statusCallback(id: number, status: TrackStatus): string {
  return `st:${id}:${status}`;
}

export function parseStatusCallback(data: string): { id: number; status: TrackStatus } | null {
  const match = /^st:(\d{1,15}):([a-z_]+)$/.exec(data);
  if (!match || !isTrackStatus(match[2])) return null;
  return { id: Number(match[1]), status: match[2] };
}

/**
 * The first Israeli mobile number in the text, as 05X-XXXXXXX. Accepts 05X or
 * +972 5X / 972 5X, with dashes or spaces between the groups.
 */
export function findPhone(text: string): string | null {
  const match = /(?<![\d+])(?:\+?972[-\s]?|0)(5\d)[-\s]?(\d{3})[-\s]?(\d{4})(?!\d)/.exec(text);
  return match ? `0${match[1]}-${match[2]}${match[3]}` : null;
}
