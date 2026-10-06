import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { withRetries } from '../util/retry.js';
import { Semaphore } from '../util/semaphore.js';

/**
 * Cheapest current tier that still handles Hebrew reliably.
 * (gemini-2.5-flash-lite is closed to new keys and 404s.)
 */
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';

/**
 * A healthy extraction takes 3-10 seconds. Waiting 90 for a stalled connection
 * held up a whole /add, so a call that overruns this is abandoned and
 * retried instead.
 */
const CALL_TIMEOUT_MS = 45_000;

/**
 * Sources are fetched concurrently, which sent every model call off at once.
 * Six at a time queued behind each other and tripped the timeout; letting two
 * run at once keeps each call fast while still overlapping the waiting.
 */
const MAX_CONCURRENT_CALLS = 2;
const gate = new Semaphore(MAX_CONCURRENT_CALLS);

/**
 * Calls occasionally hang until the socket timeout; a short pause and a retry
 * recovers the source for this cycle. A quota error gets a much longer pause,
 * because the free tier counts the failed calls too.
 */
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [2_000, 6_000];
const QUOTA_BACKOFF_MS = 20_000;

function isQuotaError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /429|RESOURCE_EXHAUSTED|quota/i.test(text);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`gemini call exceeded ${ms}ms`)), ms).unref(),
    ),
  ]);
}

let client: GoogleGenAI | null = null;

export function isGeminiConfigured(): boolean {
  return Boolean(config.geminiApiKey);
}

function getClient(): GoogleGenAI {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not set');
  client ??= new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

/**
 * Strips phone numbers before the text leaves the machine.
 *
 * Google's free tier may train on submitted content, and these posts carry
 * private people's mobile numbers. The numbers are re-attached locally
 * afterwards, so nothing is lost from the message the owner receives.
 */
export function redactPhones(text: string): { redacted: string; phones: string[] } {
  const phones: string[] = [];
  const redacted = text.replace(/0\d{1,2}[-\s]?\d{7}|\+972[-\s]?\d{1,2}[-\s]?\d{7}/g, (match) => {
    phones.push(match.trim());
    return '[טלפון]';
  });
  return { redacted, phones };
}

/**
 * One structured-output call. Returns null on any failure, because a model
 * hiccup must degrade one source for one cycle, never break the poll loop.
 */
export async function generateJson(
  prompt: string,
  schema: Record<string, unknown>,
  label = 'gemini',
): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await withRetries(
      (attempt) =>
        gate.run(async () => {
          try {
            const response = await withTimeout(
              getClient().models.generateContent({
                model: MODEL,
                contents: prompt,
                config: {
                  responseMimeType: 'application/json',
                  responseSchema: schema,
                  temperature: 0,
                  // A large listing page once ran past the default output budget
                  // and returned JSON cut off mid-string, losing the whole page.
                  maxOutputTokens: 32_768,
                },
              }),
              CALL_TIMEOUT_MS,
            );
            return response.text ?? '';
          } catch (error) {
            logger.warn({ err: error, label, attempt }, 'gemini attempt failed');
            throw error;
          }
        }),
      {
        attempts: RETRY_ATTEMPTS,
        backoffMs: RETRY_BACKOFF_MS,
        isQuotaError,
        quotaBackoffMs: QUOTA_BACKOFF_MS,
      },
    );
  } catch (error) {
    logger.error({ err: error, label }, 'gemini call failed');
    return null;
  }

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    // Truncated output is still mostly usable: close the array at the last
    // complete object rather than discarding every listing on the page.
    const repaired = repairTruncatedJson(raw);
    if (repaired) {
      logger.warn({ label, chars: raw.length }, 'gemini output truncated; recovered what parsed');
      return repaired;
    }
    logger.warn({ label, chars: raw.length }, 'gemini returned unparseable json');
    return null;
  }
}

/**
 * Salvages a truncated `{"listings":[...]}` response by cutting back to the
 * last complete object and closing the brackets.
 */
function repairTruncatedJson(raw: string): unknown | null {
  const lastComplete = raw.lastIndexOf('},');
  if (lastComplete === -1) return null;

  for (const suffix of ['}]}', '}]}}']) {
    try {
      return JSON.parse(`${raw.slice(0, lastComplete + 1)}${suffix}`);
    } catch {
      continue;
    }
  }
  return null;
}

