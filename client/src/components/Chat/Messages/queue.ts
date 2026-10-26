import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { TQueueStatusEvent } from 'librechat-data-provider';

/**
 * Fork: whether a conversation's pending reply waits in its provider's queue, and where. Set from
 * the stream's `on_queue_status` events, cleared on admission and when the run ends. Memory only:
 * a waiting turn re-sends its status, so a reattached stream shows it again.
 */
export const queueStatusFamily = atomFamily((_conversationId: string) =>
  atom<TQueueStatusEvent | null>(null),
);
