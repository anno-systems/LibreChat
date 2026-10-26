import { ErrorTypes } from 'librechat-data-provider';
import { getLangChainErrorCode } from '~/agents/errors';

/** Stable code of a turn that waited its provider queue's maximum time. */
export const QUEUE_TIMEOUT_CODE = 'QUEUE_TIMEOUT' as const;

/** The turn waited the provider's maximum wait without being admitted. */
export class ProviderQueueTimeoutError extends Error {
  readonly code: typeof QUEUE_TIMEOUT_CODE = QUEUE_TIMEOUT_CODE;

  constructor(
    readonly provider: string,
    readonly waitedMs: number,
  ) {
    super('The provider queue timed out');
    this.name = 'ProviderQueueTimeoutError';
  }
}

export function isProviderQueueTimeout(error: unknown): error is ProviderQueueTimeoutError {
  return (
    error instanceof ProviderQueueTimeoutError ||
    (error != null &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === QUEUE_TIMEOUT_CODE)
  );
}

/** Older clients cannot localize the type, so they show this sentence instead. */
const QUEUE_TIMEOUT_FALLBACK =
  'The model is overloaded right now. Please try again in a few minutes.';

/** The error part text for a queue timeout: fallback prose, then the typed payload clients localize. */
export function getProviderQueueErrorText(): string {
  return `${QUEUE_TIMEOUT_FALLBACK}\n${JSON.stringify({ type: ErrorTypes.QUEUE_TIMEOUT })}`;
}

const MAX_CAUSE_DEPTH = 4;
/** Longest pause a provider's `Retry-After` can ask for; the turn's max wait bounds it further. */
const MAX_RETRY_AFTER_MS = 15 * 60_000;

function read(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function header(headers: unknown, name: string): string | undefined {
  if (headers == null || typeof headers !== 'object') {
    return undefined;
  }
  const getter = read(headers, 'get');
  if (typeof getter === 'function') {
    try {
      const value: unknown = getter.call(headers, name);
      return typeof value === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

/** `Retry-After-Ms`, else `Retry-After` in seconds or as an HTTP date, in milliseconds. */
export function parseRetryAfter(headers: unknown, now: number = Date.now()): number | undefined {
  const ms = Number(header(headers, 'retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) {
    return Math.min(ms, MAX_RETRY_AFTER_MS);
  }
  const raw = header(headers, 'retry-after')?.trim();
  if (!raw) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
  }
  const date = Date.parse(raw);
  if (Number.isNaN(date) || date <= now) {
    return undefined;
  }
  return Math.min(date - now, MAX_RETRY_AFTER_MS);
}

export interface ProviderRateLimit {
  /** From the provider's `Retry-After`, when it sent one. */
  retryAfterMs?: number;
}

/**
 * Whether the provider answered with a rate limit (HTTP 429 or LangChain's `MODEL_RATE_LIMIT`),
 * walking a few causes deep. An exhausted quota is also a 429 but does not pass by waiting, so it
 * is not one.
 */
export function getProviderRateLimit(
  error: unknown,
  now: number = Date.now(),
): ProviderRateLimit | undefined {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    if (typeof current !== 'object') {
      return undefined;
    }
    const status = read(current, 'status') ?? read(current, 'statusCode');
    const code = read(current, 'code');
    const nested = read(current, 'error');
    const nestedCode = nested != null && typeof nested === 'object' ? read(nested, 'code') : null;
    if (code === 'insufficient_quota' || nestedCode === 'insufficient_quota') {
      return undefined;
    }
    if (status === 429 || getLangChainErrorCode(current) === 'MODEL_RATE_LIMIT') {
      const response = read(current, 'response');
      const retryAfterMs =
        parseRetryAfter(read(current, 'headers'), now) ??
        (response != null && typeof response === 'object'
          ? parseRetryAfter(read(response, 'headers'), now)
          : undefined);
      return retryAfterMs == null ? {} : { retryAfterMs };
    }
    current = read(current, 'cause');
  }
  return undefined;
}
