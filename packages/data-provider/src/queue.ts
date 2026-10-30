import { z } from 'zod';

/**
 * Provider limits and the wait queue in front of them (fork-only).
 *
 * An operator sets limits per model (`modelLimits` of a `librechat.yaml` custom endpoint or the
 * models of a platform catalog provider) or for every model of an endpoint (`limits`). A turn that
 * would exceed them waits in a first-come-first-served queue for its endpoint and model, shared by
 * every tenant, instead of failing; the stream tells the user why it waits. A model without
 * limits has no queue, which is upstream's behavior. `limits: {}` (or only a maximum wait) queues
 * nothing up front and only retries a turn the provider answered with 429.
 */

/** How long a turn waits by default before it fails with `queue_timeout`: two minutes. */
export const DEFAULT_QUEUE_MAX_WAIT_SECONDS = 120;
/** How long a provider pauses after a rate limit answer without `Retry-After`. */
export const DEFAULT_QUEUE_PAUSE_SECONDS = 10;
/** Longest wait an operator can configure: 15 minutes. */
export const MAX_QUEUE_WAIT_SECONDS = 900;

/** Limits of one model's queue; any of them set gives the model a queue. */
export const modelLimitsSchema = z
  .object({
    /** Turns that may run on the model at the same time. */
    concurrency: z.number().int().min(1).max(10_000).optional(),
    /** Turns admitted in any 60 seconds; corrected to the model calls a turn made. */
    requestsPerMinute: z.number().int().min(1).max(1_000_000).optional(),
    /** Prompt tokens estimated at admission, corrected to the tokens used, in any 60 seconds. */
    tokensPerMinute: z.number().int().min(1).max(1_000_000_000).optional(),
  })
  .strict();

export type TModelLimits = z.infer<typeof modelLimitsSchema>;

/** How a provider's queues wait, for every model of the provider. */
export const queueSettingsSchema = z
  .object({
    /** Longest wait in the queue before the turn fails; default 120. */
    maxWaitSeconds: z.number().int().min(1).max(MAX_QUEUE_WAIT_SECONDS).optional(),
    /** Pause after the provider answers 429 without `Retry-After`; default 10. */
    pauseSeconds: z.number().int().min(1).max(300).optional(),
  })
  .strict();

export type TQueueSettings = z.infer<typeof queueSettingsSchema>;

/**
 * The limits a queue runs with: a model's limits and its provider's queue settings. Queues are
 * kept per (endpoint, model), so two models of one endpoint never wait for each other.
 */
export const providerLimitsSchema = modelLimitsSchema.merge(queueSettingsSchema).strict();

export type TProviderLimits = z.infer<typeof providerLimitsSchema>;

/** Why a turn waits: the operator's limits are reached, or the provider answered 429. */
export type TQueueReason = 'provider_busy' | 'rate_limited';

/**
 * Streamed while a turn waits for its provider. `queued: false` clears the status when the turn
 * is admitted; a run that ends while queued clears it on the client.
 */
export type TQueueStatusEvent = {
  queued: boolean;
  /** 1-based place in the provider's queue. */
  position?: number;
  reason?: TQueueReason;
  conversationId?: string;
  responseMessageId?: string;
};

export enum QueueEvents {
  ON_QUEUE_STATUS = 'on_queue_status',
}
