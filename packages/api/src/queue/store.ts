import type { TProviderLimits, TQueueReason } from 'librechat-data-provider';

/**
 * State of the provider queues (fork-only). One queue per provider, shared by every tenant of
 * the deployment. The gate (`gate.ts`) waits and decides when to ask again; the store keeps the
 * queue order, the admitted turns and the 60-second window, and decides admission atomically.
 *
 * The in-memory store (`memory.ts`) serves one process. Several replicas need a shared store
 * (Redis: the queue as a list, the window as a sorted set, `tryAdmit` as one Lua script, change
 * notifications over pub/sub plus the gate's timed re-checks), passed to the gate instead.
 */

/** A turn's place in a provider's queue. */
export interface QueueTicket {
  id: string;
  /** Estimated prompt tokens, charged to the window at admission. */
  tokens: number;
}

export type AdmissionDecision =
  | { admitted: true }
  | {
      admitted: false;
      /** 1-based; 0 when the ticket is no longer queued. */
      position: number;
      reason: TQueueReason;
      /** When asking again can succeed without another change (a window entry expires, a pause
       *  ends); absent when only a change (a release, someone ahead leaving) can admit it. */
      retryAt?: number;
    };

/** What an admitted turn used, replacing its estimate in the window. */
export interface QueueUsage {
  tokens: number;
  /** Model calls the turn made; at least one is counted. */
  requests: number;
}

export interface ProviderQueueStore {
  /** Appends the ticket, or puts it at the head (a turn the provider rate-limited keeps its turn). */
  enqueue(provider: string, ticket: QueueTicket, options?: { front?: boolean }): Promise<void>;
  /**
   * Admits the ticket if it heads the queue, the provider is not paused and the limits allow
   * it: removes it from the queue, takes a slot and charges the window. Atomic.
   */
  tryAdmit(
    provider: string,
    ticketId: string,
    limits: TProviderLimits,
    now: number,
  ): Promise<AdmissionDecision>;
  /** Removes a ticket that was not admitted (Stop, timeout). No-op when it is not queued. */
  leave(provider: string, ticketId: string): Promise<void>;
  /** Frees an admitted ticket's slot and replaces its window charge with what it used. Idempotent. */
  release(provider: string, ticketId: string, usage: QueueUsage, now: number): Promise<void>;
  /** Admits nobody before `until` (the provider answered 429). Keeps the later of two pauses. */
  pause(provider: string, until: number): Promise<void>;
  /** Calls `listener` after every change that can admit or move a waiter; returns unsubscribe. */
  subscribe(provider: string, listener: () => void): () => void;
}
