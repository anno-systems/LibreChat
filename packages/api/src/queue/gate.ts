import { randomUUID } from 'node:crypto';
import type { TProviderLimits, TQueueReason } from 'librechat-data-provider';
import type { ProviderQueueStore, QueueUsage } from './store';
import { ProviderQueueTimeoutError } from './errors';

/** A waiting turn re-sends an unchanged status this often, so a client that reattached sees it. */
const DEFAULT_STATUS_INTERVAL_MS = 15_000;

export interface QueueWaitStatus {
  position: number;
  reason: TQueueReason;
}

export interface AdmitOptions {
  provider: string;
  limits: TProviderLimits;
  /** Estimated prompt tokens of the turn. */
  tokens: number;
  /** Epoch ms after which the turn stops waiting with `ProviderQueueTimeoutError`. */
  deadline: number;
  /** Stop: the turn leaves the queue and the wait rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Keeps one id across a rate-limited retry. */
  ticketId?: string;
  /** Joins at the head (a retry after the provider answered 429). */
  front?: boolean;
  /** The wait's status while it waits, and `null` once admitted after waiting. */
  onStatus?: (status: QueueWaitStatus | null) => void;
}

export interface QueueAdmission {
  ticketId: string;
  /** Time spent waiting before admission. */
  waitedMs: number;
  /** Frees the slot and records what the turn used. Idempotent. */
  release(usage: QueueUsage): Promise<void>;
}

export interface ProviderGate {
  /** Waits in the provider's queue until the turn may run. */
  admit(options: AdmitOptions): Promise<QueueAdmission>;
  /** Admits nobody on the provider before `until`. */
  pause(provider: string, until: number): Promise<void>;
}

export interface ProviderGateDeps {
  store: ProviderQueueStore;
  now?: () => number;
  statusIntervalMs?: number;
  createId?: () => string;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

/**
 * The provider gate (fork-only): strict first-come-first-served admission per queue, global
 * across tenants because the queues are keyed by endpoint and model only (`queueKey`, passed as
 * `provider`). Waiting is event-driven (the store's change notifications) with timed re-checks
 * for window expiry, pauses, the deadline and the status refresh, so a shared store whose
 * notifications can be lost still makes progress.
 */
export function createProviderGate(deps: ProviderGateDeps): ProviderGate {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const statusIntervalMs = deps.statusIntervalMs ?? DEFAULT_STATUS_INTERVAL_MS;
  const createId = deps.createId ?? randomUUID;

  async function admit(options: AdmitOptions): Promise<QueueAdmission> {
    const { provider, limits, signal, deadline, onStatus } = options;
    const ticketId = options.ticketId ?? createId();
    const startedAt = now();
    if (signal?.aborted) {
      throw abortReason(signal);
    }

    let changed = false;
    let wake: (() => void) | undefined;
    const unsubscribe = store.subscribe(provider, () => {
      changed = true;
      wake?.();
    });
    const onAbort = () => wake?.();
    signal?.addEventListener('abort', onAbort);

    let lastStatus: QueueWaitStatus | undefined;
    let lastSentAt = 0;
    let admitted = false;
    try {
      await store.enqueue(
        provider,
        { id: ticketId, tokens: options.tokens },
        { front: options.front },
      );
      for (;;) {
        if (signal?.aborted) {
          throw abortReason(signal);
        }
        changed = false;
        const at = now();
        const decision = await store.tryAdmit(provider, ticketId, limits, at);
        if (decision.admitted) {
          admitted = true;
          if (lastStatus) {
            onStatus?.(null);
          }
          break;
        }
        if (at >= deadline || decision.position === 0) {
          throw new ProviderQueueTimeoutError(provider, at - startedAt);
        }
        const status = { position: decision.position, reason: decision.reason };
        if (
          lastStatus?.position !== status.position ||
          lastStatus.reason !== status.reason ||
          at - lastSentAt >= statusIntervalMs
        ) {
          lastStatus = status;
          lastSentAt = at;
          onStatus?.(status);
        }
        if (changed) {
          continue;
        }
        const wakeAt = Math.min(
          deadline,
          decision.retryAt ?? Infinity,
          lastSentAt + statusIntervalMs,
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, Math.max(0, wakeAt - now()));
          function done() {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          }
          wake = done;
          /** A Stop that landed while the store answered has already fired its listener. */
          if (signal?.aborted) {
            done();
          }
        });
      }
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      if (!admitted) {
        await store.leave(provider, ticketId);
      }
    }

    const waitedMs = now() - startedAt;
    let released = false;
    return {
      ticketId,
      waitedMs,
      async release(usage) {
        if (released) {
          return;
        }
        released = true;
        await store.release(provider, ticketId, usage, now());
      },
    };
  }

  return {
    admit,
    pause: (provider, until) => store.pause(provider, until),
  };
}
