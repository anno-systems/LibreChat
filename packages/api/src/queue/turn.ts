import { randomUUID } from 'node:crypto';
import {
  normalizeEndpointName,
  DEFAULT_QUEUE_PAUSE_SECONDS,
  DEFAULT_QUEUE_MAX_WAIT_SECONDS,
} from 'librechat-data-provider';
import type { TProviderLimits, TQueueStatusEvent } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { ProviderGate, QueueWaitStatus } from './gate';
import type { QueueUsage } from './store';
import { ProviderQueueTimeoutError, getProviderRateLimit } from './errors';

/** One usage row of a turn (`collectedUsage`), as far as the queue reads it. */
export interface TurnUsageRow {
  input_tokens?: number;
  output_tokens?: number;
}

export interface ProviderQueuedTurnOptions<T> {
  /** Absent: the deployment has no gate and the turn runs as upstream's. */
  gate?: ProviderGate;
  /** The turn's merged config, whose custom endpoint carries the provider's `limits`. */
  appConfig?: AppConfig;
  /** The endpoint name the turn's agent runs on (`agent.endpoint`). */
  endpoint?: string;
  signal: AbortSignal;
  /** The turn's model, run again after a 429 that came before any content. */
  run: () => Promise<T>;
  /** Estimated prompt tokens, read once at admission. */
  promptTokens?: () => number;
  /** The turn's usage rows; the rows added since admission are what the attempt used. */
  usage?: () => readonly (TurnUsageRow | null | undefined)[] | undefined;
  /** The response's content parts, to tell whether anything streamed before a 429. */
  content?: () => readonly unknown[] | undefined;
  emitStatus?: (status: TQueueStatusEvent) => unknown;
  /** Copied onto every status event, so the client finds the pending reply. */
  statusContext?: Pick<TQueueStatusEvent, 'conversationId' | 'responseMessageId'>;
  /** False where the model cannot simply run again (a resumed turn); a 429 then fails as today. */
  retryRateLimited?: boolean;
  now?: () => number;
  onEmitError?: (error: unknown) => void;
}

/** The provider's limits from the turn's config, or `undefined` when it has no queue. */
export function resolveProviderLimits(
  appConfig: AppConfig | undefined,
  endpoint: string | undefined,
): TProviderLimits | undefined {
  if (!endpoint) {
    return undefined;
  }
  const name = normalizeEndpointName(endpoint);
  const config = appConfig?.endpoints?.custom?.find(
    (candidate) => normalizeEndpointName(candidate?.name ?? '') === name,
  );
  return (config as { limits?: TProviderLimits } | undefined)?.limits ?? undefined;
}

/** Sum of a token count map's values (`indexTokenCountMap`): the prompt the turn sends. */
export function sumTokenCounts(counts: Record<string, unknown> | undefined | null): number {
  let total = 0;
  for (const value of Object.values(counts ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      total += value;
    }
  }
  return total;
}

/** Tokens and model calls in usage rows. */
export function summarizeTurnUsage(
  rows: readonly (TurnUsageRow | null | undefined)[] | undefined,
): QueueUsage {
  let tokens = 0;
  let requests = 0;
  for (const row of rows ?? []) {
    if (row == null) {
      continue;
    }
    const input = Number(row.input_tokens) || 0;
    const output = Number(row.output_tokens) || 0;
    tokens += Math.max(0, input) + Math.max(0, output);
    requests += 1;
  }
  return { tokens, requests };
}

/** Whether a reply already shows something; error parts do not count. */
export function hasStreamedContent(parts: readonly unknown[] | undefined): boolean {
  return (parts ?? []).some(
    (part) =>
      part != null && typeof part === 'object' && (part as { type?: unknown }).type !== 'error',
  );
}

/**
 * Runs one turn behind its provider's queue (fork-only). The unit is the turn: it takes one slot
 * for its whole run, sub-agents and tool loops included, is charged one request and its estimated
 * prompt at admission, and on release the window holds what the turn used (all model calls and
 * tokens). A provider without `limits` runs the turn directly, as upstream does.
 *
 * A rate limit (429) before any content puts the turn back at the head of the queue and pauses
 * the provider (its `Retry-After`, else `pauseSeconds`), within the turn's remaining wait. After
 * content, or once the wait is used up, it fails as before; a wait past `maxWaitSeconds` fails
 * with `ProviderQueueTimeoutError`. A Stop while waiting leaves the queue and rejects with the
 * signal's reason, which the caller already treats as a cancellation.
 */
export async function runProviderQueuedTurn<T>(options: ProviderQueuedTurnOptions<T>): Promise<T> {
  const { gate, endpoint, signal, run } = options;
  const limits = resolveProviderLimits(options.appConfig, endpoint);
  if (gate == null || limits == null || !endpoint) {
    return run();
  }
  const provider = normalizeEndpointName(endpoint);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + (limits.maxWaitSeconds ?? DEFAULT_QUEUE_MAX_WAIT_SECONDS) * 1000;
  const ticketId = randomUUID();

  const emit = (status: QueueWaitStatus | null) => {
    if (!options.emitStatus) {
      return;
    }
    const event: TQueueStatusEvent = status
      ? { queued: true, position: status.position, reason: status.reason, ...options.statusContext }
      : { queued: false, ...options.statusContext };
    try {
      void Promise.resolve(options.emitStatus(event)).catch(options.onEmitError);
    } catch (error) {
      options.onEmitError?.(error);
    }
  };

  let front = false;
  const tokens = Math.max(0, Math.round(options.promptTokens?.() ?? 0));
  for (;;) {
    const admission = await gate.admit({
      provider,
      limits,
      tokens,
      deadline,
      signal,
      ticketId,
      front,
      onStatus: emit,
    });
    const usageStart = options.usage?.()?.length ?? 0;
    const used = () => {
      const summary = summarizeTurnUsage(options.usage?.()?.slice(usageStart));
      return summary.requests > 0 || summary.tokens > 0 ? summary : { tokens, requests: 1 };
    };
    try {
      const result = await run();
      await admission.release(used());
      return result;
    } catch (error) {
      const rateLimit = signal.aborted ? undefined : getProviderRateLimit(error, now());
      if (!rateLimit) {
        await admission.release(used());
        throw error;
      }
      const pausedUntil =
        now() +
        (rateLimit.retryAfterMs ?? (limits.pauseSeconds ?? DEFAULT_QUEUE_PAUSE_SECONDS) * 1000);
      /** The rejected call reached the provider: one request, no tokens. */
      await admission.release({ tokens: 0, requests: 1 });
      await gate.pause(provider, pausedUntil);
      const retryable =
        options.retryRateLimited !== false && !hasStreamedContent(options.content?.());
      if (!retryable) {
        throw error;
      }
      if (pausedUntil >= deadline) {
        throw new ProviderQueueTimeoutError(provider, now() - startedAt);
      }
      front = true;
    }
  }
}
