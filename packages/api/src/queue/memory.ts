import type { TProviderLimits } from 'librechat-data-provider';
import type { QueueUsage, QueueTicket, AdmissionDecision, ProviderQueueStore } from './store';

/** The rolling window requests and tokens per minute are counted in. */
export const QUEUE_WINDOW_MS = 60_000;

/** An admitted turn that never released is dropped after this, so a lost release cannot block a
 *  provider for good. Longer than any turn should take. */
const DEFAULT_LEASE_MS = 30 * 60_000;

interface Charge {
  at: number;
  tokens: number;
  requests: number;
}

interface ProviderState {
  queue: QueueTicket[];
  /** Admitted tickets and their charge at admission. */
  active: Map<string, Charge>;
  /** Charges of released tickets, at release time, until they leave the window. */
  closed: Charge[];
  pausedUntil: number;
  listeners: Set<() => void>;
}

export interface MemoryQueueStoreOptions {
  /** How long an admitted ticket holds its slot without a release; default 30 minutes. */
  leaseMs?: number;
}

/**
 * The time at which enough of the window's charges have expired for `needed` more of `field`
 * to fit under `limit`. Charges expire one window after they were made.
 */
function expiryFor(
  charges: Charge[],
  field: 'tokens' | 'requests',
  used: number,
  needed: number,
  limit: number,
): number | undefined {
  let remaining = used;
  for (const charge of [...charges].sort((a, b) => a.at - b.at)) {
    remaining -= charge[field];
    if (remaining <= 0 || remaining + needed <= limit) {
      return charge.at + QUEUE_WINDOW_MS;
    }
  }
  return undefined;
}

/**
 * Provider queues of one process. Every operation is synchronous under the hood, so admission
 * is atomic without locks.
 */
export function createMemoryQueueStore(options: MemoryQueueStoreOptions = {}): ProviderQueueStore {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const providers = new Map<string, ProviderState>();

  const stateOf = (provider: string): ProviderState => {
    let state = providers.get(provider);
    if (!state) {
      state = { queue: [], active: new Map(), closed: [], pausedUntil: 0, listeners: new Set() };
      providers.set(provider, state);
    }
    return state;
  };

  const notify = (state: ProviderState) => {
    for (const listener of [...state.listeners]) {
      listener();
    }
  };

  const prune = (state: ProviderState, now: number) => {
    state.closed = state.closed.filter((charge) => now - charge.at < QUEUE_WINDOW_MS);
    for (const [id, charge] of state.active) {
      if (now - charge.at >= leaseMs) {
        state.active.delete(id);
      }
    }
  };

  /** Released charges, plus the estimates of admitted turns still inside the window. */
  const windowOf = (state: ProviderState, now: number): Charge[] => [
    ...state.closed,
    ...[...state.active.values()].filter((charge) => now - charge.at < QUEUE_WINDOW_MS),
  ];

  const sum = (charges: Charge[], field: 'tokens' | 'requests') =>
    charges.reduce((total, charge) => total + charge[field], 0);

  return {
    async enqueue(provider, ticket, enqueueOptions) {
      const state = stateOf(provider);
      if (state.queue.some((queued) => queued.id === ticket.id)) {
        return;
      }
      if (enqueueOptions?.front === true) {
        state.queue.unshift({ ...ticket });
        notify(state);
        return;
      }
      state.queue.push({ ...ticket });
    },

    async tryAdmit(provider, ticketId, limits: TProviderLimits, now): Promise<AdmissionDecision> {
      const state = stateOf(provider);
      prune(state, now);
      const index = state.queue.findIndex((queued) => queued.id === ticketId);
      if (index < 0) {
        return { admitted: false, position: 0, reason: 'provider_busy' };
      }
      const position = index + 1;
      if (state.pausedUntil > now) {
        return { admitted: false, position, reason: 'rate_limited', retryAt: state.pausedUntil };
      }
      if (index > 0) {
        return { admitted: false, position, reason: 'provider_busy' };
      }
      const ticket = state.queue[0];
      if (limits.concurrency != null && state.active.size >= limits.concurrency) {
        const oldest = Math.min(...[...state.active.values()].map((charge) => charge.at));
        return { admitted: false, position, reason: 'provider_busy', retryAt: oldest + leaseMs };
      }
      const charges = windowOf(state, now);
      if (limits.requestsPerMinute != null) {
        const used = sum(charges, 'requests');
        if (used + 1 > limits.requestsPerMinute) {
          const retryAt = expiryFor(charges, 'requests', used, 1, limits.requestsPerMinute);
          return { admitted: false, position, reason: 'provider_busy', retryAt };
        }
      }
      if (limits.tokensPerMinute != null) {
        const used = sum(charges, 'tokens');
        /** An empty window admits any turn, or one larger than the whole budget never would. */
        if (used > 0 && used + ticket.tokens > limits.tokensPerMinute) {
          const retryAt = expiryFor(charges, 'tokens', used, ticket.tokens, limits.tokensPerMinute);
          return { admitted: false, position, reason: 'provider_busy', retryAt };
        }
      }
      state.queue.shift();
      state.active.set(ticket.id, { at: now, tokens: Math.max(0, ticket.tokens), requests: 1 });
      notify(state);
      return { admitted: true };
    },

    async leave(provider, ticketId) {
      const state = stateOf(provider);
      const index = state.queue.findIndex((queued) => queued.id === ticketId);
      if (index < 0) {
        return;
      }
      state.queue.splice(index, 1);
      notify(state);
    },

    async release(provider, ticketId, usage: QueueUsage, now) {
      const state = stateOf(provider);
      if (!state.active.delete(ticketId)) {
        return;
      }
      state.closed.push({
        at: now,
        tokens: Math.max(0, Math.round(usage.tokens) || 0),
        requests: Math.max(1, Math.round(usage.requests) || 0),
      });
      notify(state);
    },

    async pause(provider, until) {
      const state = stateOf(provider);
      if (until <= state.pausedUntil) {
        return;
      }
      state.pausedUntil = until;
      notify(state);
    },

    subscribe(provider, listener) {
      const state = stateOf(provider);
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
  };
}
