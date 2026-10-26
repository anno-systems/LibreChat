import type { TProviderLimits } from 'librechat-data-provider';
import type { QueueWaitStatus } from './gate';
import { createMemoryQueueStore, QUEUE_WINDOW_MS } from './memory';
import { ProviderQueueTimeoutError } from './errors';
import { createProviderGate } from './gate';

const PROVIDER = 'mistral-eu';
const LONG_WAIT = 10 * 60_000;

function setup() {
  const store = createMemoryQueueStore();
  const gate = createProviderGate({ store });
  const admitted: string[] = [];
  const admit = (
    id: string,
    limits: TProviderLimits,
    extra: {
      tokens?: number;
      signal?: AbortSignal;
      onStatus?: (s: QueueWaitStatus | null) => void;
    } = {},
  ) =>
    gate
      .admit({
        provider: PROVIDER,
        limits,
        tokens: extra.tokens ?? 0,
        deadline: Date.now() + LONG_WAIT,
        ticketId: id,
        signal: extra.signal,
        onStatus: extra.onStatus,
      })
      .then((admission) => {
        admitted.push(id);
        return admission;
      });
  return { store, gate, admit, admitted };
}

/** Lets every pending promise chain settle without moving the clock. */
const flush = () => jest.advanceTimersByTimeAsync(0);

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-10-26T10:00:00Z') });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('provider gate', () => {
  it('admits strictly in arrival order as slots free up', async () => {
    const { admit, admitted } = setup();
    const limits = { concurrency: 1 };
    const first = await admit('a', limits);
    const waiting = ['b', 'c', 'd'].map((id) => admit(id, limits));
    await flush();
    expect(admitted).toEqual(['a']);

    await first.release({ tokens: 0, requests: 1 });
    const second = await waiting[0];
    await flush();
    expect(admitted).toEqual(['a', 'b']);

    await second.release({ tokens: 0, requests: 1 });
    const third = await waiting[1];
    await third.release({ tokens: 0, requests: 1 });
    await waiting[2];
    expect(admitted).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never lets a later ticket overtake the head, even when it asks first', async () => {
    const { store } = setup();
    const now = Date.now();
    await store.enqueue(PROVIDER, { id: 'head', tokens: 0 });
    await store.enqueue(PROVIDER, { id: 'next', tokens: 0 });
    expect(await store.tryAdmit(PROVIDER, 'next', {}, now)).toEqual({
      admitted: false,
      position: 2,
      reason: 'provider_busy',
    });
    expect(await store.tryAdmit(PROVIDER, 'head', {}, now)).toEqual({ admitted: true });
    expect(await store.tryAdmit(PROVIDER, 'next', {}, now)).toEqual({ admitted: true });
  });

  it('holds concurrency to the limit', async () => {
    const { admit, admitted } = setup();
    const limits = { concurrency: 2 };
    const [a] = await Promise.all([admit('a', limits), admit('b', limits)]);
    const c = admit('c', limits);
    await flush();
    expect(admitted).toEqual(['a', 'b']);
    await a.release({ tokens: 0, requests: 1 });
    await c;
    expect(admitted).toEqual(['a', 'b', 'c']);
  });

  it('counts requests per minute in a rolling window and corrects them to the calls made', async () => {
    const { admit, admitted } = setup();
    const limits = { requestsPerMinute: 3 };
    const a = await admit('a', limits);
    /** The turn made two model calls: together with `b` the window is full. */
    await a.release({ tokens: 0, requests: 2 });
    await admit('b', limits);
    const c = admit('c', limits);
    await jest.advanceTimersByTimeAsync(QUEUE_WINDOW_MS - 1_000);
    expect(admitted).toEqual(['a', 'b']);
    await jest.advanceTimersByTimeAsync(1_000);
    await c;
    expect(admitted).toEqual(['a', 'b', 'c']);
  });

  it('charges estimated prompt tokens at admission and the tokens used on release', async () => {
    const { admit, admitted } = setup();
    const limits = { tokensPerMinute: 1_000 };
    const a = await admit('a', limits, { tokens: 800 });
    const b = admit('b', limits, { tokens: 300 });
    await flush();
    expect(admitted).toEqual(['a']);
    /** The estimate was high: 100 tokens used leave room for `b` at once. */
    await a.release({ tokens: 100, requests: 1 });
    await b;
    expect(admitted).toEqual(['a', 'b']);
  });

  it('admits a turn larger than the whole token budget once the window is empty', async () => {
    const { admit, admitted } = setup();
    const limits = { tokensPerMinute: 1_000 };
    const a = await admit('a', limits, { tokens: 500 });
    await a.release({ tokens: 500, requests: 1 });
    const big = admit('big', limits, { tokens: 5_000 });
    await jest.advanceTimersByTimeAsync(QUEUE_WINDOW_MS - 1);
    expect(admitted).toEqual(['a']);
    await jest.advanceTimersByTimeAsync(1);
    await big;
    expect(admitted).toEqual(['a', 'big']);
  });

  it('streams position updates for a waiting turn', async () => {
    const { admit } = setup();
    const limits = { concurrency: 1 };
    const statuses: (QueueWaitStatus | null)[] = [];
    const first = await admit('a', limits);
    const second = admit('b', limits);
    const third = admit('c', limits, { onStatus: (status) => statuses.push(status) });
    await flush();
    expect(statuses).toEqual([{ position: 2, reason: 'provider_busy' }]);

    await first.release({ tokens: 0, requests: 1 });
    const b = await second;
    await flush();
    expect(statuses).toEqual([
      { position: 2, reason: 'provider_busy' },
      { position: 1, reason: 'provider_busy' },
    ]);

    await b.release({ tokens: 0, requests: 1 });
    await third;
    expect(statuses[statuses.length - 1]).toBeNull();
  });

  it('re-sends an unchanged status periodically for clients that reattach', async () => {
    const { admit } = setup();
    const statuses: (QueueWaitStatus | null)[] = [];
    await admit('a', { concurrency: 1 });
    void admit('b', { concurrency: 1 }, { onStatus: (status) => statuses.push(status) }).catch(
      () => undefined,
    );
    await flush();
    await jest.advanceTimersByTimeAsync(15_000);
    expect(statuses).toEqual([
      { position: 1, reason: 'provider_busy' },
      { position: 1, reason: 'provider_busy' },
    ]);
  });

  it('frees the position of a turn that is stopped while waiting', async () => {
    const { admit, admitted } = setup();
    const limits = { concurrency: 1 };
    const first = await admit('a', limits);
    const controller = new AbortController();
    const stopped = admit('b', limits, { signal: controller.signal });
    const statuses: (QueueWaitStatus | null)[] = [];
    const next = admit('c', limits, { onStatus: (status) => statuses.push(status) });
    await flush();
    expect(statuses).toEqual([{ position: 2, reason: 'provider_busy' }]);

    const reason = new Error('stopped');
    controller.abort(reason);
    await expect(stopped).rejects.toBe(reason);
    await flush();
    expect(statuses[statuses.length - 1]).toEqual({ position: 1, reason: 'provider_busy' });

    await first.release({ tokens: 0, requests: 1 });
    await next;
    expect(admitted).toEqual(['a', 'c']);
  });

  it('fails with a queue timeout after the maximum wait and leaves the queue', async () => {
    const { gate, admit, admitted } = setup();
    const limits = { concurrency: 1 };
    const first = await admit('a', limits);
    const waiting = gate.admit({
      provider: PROVIDER,
      limits,
      tokens: 0,
      deadline: Date.now() + 120_000,
    });
    const outcome = waiting.then(
      () => undefined,
      (error: unknown) => error,
    );
    const after = admit('later', limits);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(await outcome).toBeInstanceOf(ProviderQueueTimeoutError);

    await first.release({ tokens: 0, requests: 1 });
    await after;
    expect(admitted).toEqual(['a', 'later']);
  });

  it('keeps every turn waiting while the provider is paused, with the rate-limit reason', async () => {
    const { gate, admit, admitted } = setup();
    const statuses: (QueueWaitStatus | null)[] = [];
    await gate.pause(PROVIDER, Date.now() + 5_000);
    const waiting = admit('a', {}, { onStatus: (status) => statuses.push(status) });
    await jest.advanceTimersByTimeAsync(4_999);
    expect(admitted).toEqual([]);
    expect(statuses).toEqual([{ position: 1, reason: 'rate_limited' }]);
    await jest.advanceTimersByTimeAsync(1);
    await waiting;
    expect(statuses[statuses.length - 1]).toBeNull();
  });

  it('puts a retried turn at the head of the queue', async () => {
    const { gate, admit, admitted } = setup();
    const limits = { concurrency: 1 };
    const first = await admit('a', limits);
    const queued = admit('b', limits);
    await flush();
    const retried = gate
      .admit({
        provider: PROVIDER,
        limits,
        tokens: 0,
        deadline: Date.now() + LONG_WAIT,
        ticketId: 'retry',
        front: true,
      })
      .then((admission) => {
        admitted.push('retry');
        return admission;
      });
    await flush();

    await first.release({ tokens: 0, requests: 1 });
    const retry = await retried;
    await flush();
    expect(admitted).toEqual(['a', 'retry']);
    await retry.release({ tokens: 0, requests: 1 });
    await queued;
    expect(admitted).toEqual(['a', 'retry', 'b']);
  });
});
