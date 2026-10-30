import { ErrorTypes, QueueEvents } from 'librechat-data-provider';
import type { TProviderLimits, TQueueStatusEvent } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { TurnUsageRow } from './turn';
import {
  sumTokenCounts,
  summarizeTurnUsage,
  hasStreamedContent,
  runProviderQueuedTurn,
  resolveModelLimits,
  queueKey,
} from './turn';
import { ProviderQueueTimeoutError, getProviderQueueErrorText } from './errors';
import { createMemoryQueueStore } from './memory';
import { createProviderGate } from './gate';

const ENDPOINT = 'Mistral EU';

function configWith(limits?: TProviderLimits): AppConfig {
  return {
    endpoints: { custom: [{ name: ENDPOINT, ...(limits && { limits }) }] },
  } as unknown as AppConfig;
}

function rateLimitError(retryAfter?: string) {
  return Object.assign(new Error('429 Too Many Requests'), {
    status: 429,
    ...(retryAfter != null && { headers: { 'retry-after': retryAfter } }),
  });
}

function setup(
  limits: TProviderLimits = { concurrency: 1 },
  appConfig: AppConfig = configWith(limits),
) {
  const gate = createProviderGate({ store: createMemoryQueueStore() });
  const turn = (
    run: () => Promise<string>,
    extra: {
      content?: unknown[];
      usage?: TurnUsageRow[];
      statuses?: TQueueStatusEvent[];
      signal?: AbortSignal;
      retryRateLimited?: boolean;
      model?: string;
    } = {},
  ) =>
    runProviderQueuedTurn({
      gate,
      appConfig,
      endpoint: ENDPOINT,
      model: extra.model ?? 'large',
      signal: extra.signal ?? new AbortController().signal,
      run,
      promptTokens: () => 10,
      usage: () => extra.usage,
      content: () => extra.content,
      statusContext: { conversationId: 'convo-1', responseMessageId: 'response-1' },
      emitStatus: (status) => extra.statuses?.push(status),
      retryRateLimited: extra.retryRateLimited,
    });
  return { gate, turn };
}

/** A turn that runs until `finish` is called. */
function pending() {
  let finish!: (value: string) => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<string>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { run: () => done, finish, fail };
}

const flush = () => jest.advanceTimersByTimeAsync(0);

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-10-26T10:00:00Z') });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('runProviderQueuedTurn', () => {
  it('runs a turn on a provider without limits directly, as upstream does', async () => {
    const gate = createProviderGate({ store: createMemoryQueueStore() });
    const admit = jest.spyOn(gate, 'admit');
    const result = await runProviderQueuedTurn({
      gate,
      appConfig: configWith(undefined),
      endpoint: ENDPOINT,
      signal: new AbortController().signal,
      run: async () => 'done',
    });
    expect(result).toBe('done');
    expect(admit).not.toHaveBeenCalled();
  });

  it('queues a turn behind a busy provider, reports its place and clears it on admission', async () => {
    const { turn } = setup();
    const first = pending();
    const running = turn(first.run);
    const statuses: TQueueStatusEvent[] = [];
    const second = turn(async () => 'second', { statuses });
    await flush();
    expect(statuses).toEqual([
      {
        queued: true,
        position: 1,
        reason: 'provider_busy',
        conversationId: 'convo-1',
        responseMessageId: 'response-1',
      },
    ]);

    first.finish('first');
    await expect(running).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(statuses[statuses.length - 1]).toEqual({
      queued: false,
      conversationId: 'convo-1',
      responseMessageId: 'response-1',
    });
  });

  it('frees the slot when the turn fails', async () => {
    const { turn } = setup();
    const error = new Error('tool crashed');
    await expect(
      turn(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    await expect(turn(async () => 'next')).resolves.toBe('next');
  });

  it('frees the slot when the turn is stopped while running', async () => {
    const { turn } = setup();
    const controller = new AbortController();
    const first = pending();
    const running = turn(first.run, { signal: controller.signal });
    const next = turn(async () => 'next');
    await flush();
    controller.abort();
    first.fail(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    await expect(running).rejects.toThrow('Aborted');
    await expect(next).resolves.toBe('next');
  });

  it('retries a turn the provider rate-limited before any content, after its Retry-After', async () => {
    const { turn } = setup();
    const statuses: TQueueStatusEvent[] = [];
    let attempts = 0;
    const result = turn(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw rateLimitError('3');
        }
        return 'answered';
      },
      { statuses },
    );
    await jest.advanceTimersByTimeAsync(2_999);
    expect(attempts).toBe(1);
    expect(statuses.map(({ queued, reason, position }) => ({ queued, reason, position }))).toEqual([
      { queued: true, reason: 'rate_limited', position: 1 },
    ]);
    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('answered');
    expect(attempts).toBe(2);
    expect(statuses[statuses.length - 1]?.queued).toBe(false);
  });

  it('pauses the whole provider after a rate limit, so later turns wait too', async () => {
    const { turn } = setup({});
    let attempts = 0;
    const limited = turn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw rateLimitError();
      }
      return 'retried';
    });
    await flush();
    const statuses: TQueueStatusEvent[] = [];
    let ran = false;
    const later = turn(
      async () => {
        ran = true;
        return 'later';
      },
      { statuses },
    );
    await jest.advanceTimersByTimeAsync(9_999);
    expect(ran).toBe(false);
    /** The retried turn kept its place at the head. */
    expect(statuses[0]).toMatchObject({ queued: true, position: 2, reason: 'rate_limited' });
    await jest.advanceTimersByTimeAsync(1);
    await expect(limited).resolves.toBe('retried');
    await expect(later).resolves.toBe('later');
  });

  it('fails as before when the rate limit comes after content has streamed', async () => {
    const { turn } = setup();
    const error = rateLimitError();
    await expect(
      turn(
        async () => {
          throw error;
        },
        { content: [{ type: 'text', text: 'Partial' }] },
      ),
    ).rejects.toBe(error);
  });

  it('does not retry a resumed turn', async () => {
    const { turn } = setup();
    const error = rateLimitError();
    await expect(
      turn(
        async () => {
          throw error;
        },
        { retryRateLimited: false },
      ),
    ).rejects.toBe(error);
  });

  it('does not wait on an exhausted quota, which a pause does not cure', async () => {
    const { turn } = setup();
    const error = Object.assign(new Error('429 quota'), {
      status: 429,
      code: 'insufficient_quota',
    });
    let attempts = 0;
    await expect(
      turn(async () => {
        attempts += 1;
        throw error;
      }),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  });

  it('times out when the provider asks for a pause longer than the remaining wait', async () => {
    const { turn } = setup({ maxWaitSeconds: 30 });
    await expect(
      turn(async () => {
        throw rateLimitError('60');
      }),
    ).rejects.toBeInstanceOf(ProviderQueueTimeoutError);
  });

  it('times out after the maximum wait, two minutes by default', async () => {
    const { turn } = setup();
    const first = pending();
    void turn(first.run);
    const waiting = turn(async () => 'never');
    const outcome = waiting.then(
      () => undefined,
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(119_999);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeInstanceOf(ProviderQueueTimeoutError);
    first.finish('done');
  });

  it('charges the window with what the turn used, not its estimate', async () => {
    const { turn } = setup({ tokensPerMinute: 1_000 });
    const usage: TurnUsageRow[] = [];
    await turn(
      async () => {
        usage.push(
          { input_tokens: 600, output_tokens: 300 },
          { input_tokens: 95, output_tokens: 0 },
        );
        return 'done';
      },
      { usage },
    );
    let ran = false;
    const next = turn(async () => {
      ran = true;
      return 'next';
    });
    /** 995 tokens used: the next turn's estimate of 10 waits for them to leave the window. */
    await jest.advanceTimersByTimeAsync(59_999);
    expect(ran).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toBe('next');
  });
});

describe('queue helpers', () => {
  it('reads limits from the matching custom endpoint, case-insensitively for mixed names', () => {
    const limits = { concurrency: 3 };
    expect(resolveModelLimits(configWith(limits), ENDPOINT, 'large')).toEqual(limits);
    expect(resolveModelLimits(configWith(limits), 'other', 'large')).toBeUndefined();
    expect(resolveModelLimits(undefined, ENDPOINT, 'large')).toBeUndefined();
  });

  it("puts a model's own limits over the endpoint's and leaves models without any unqueued", () => {
    const appConfig = {
      endpoints: {
        custom: [
          {
            name: ENDPOINT,
            modelLimits: {
              large: { concurrency: 1, maxWaitSeconds: 30 },
              small: { requestsPerMinute: 60 },
            },
          },
          {
            name: 'Shared',
            limits: { concurrency: 4, pauseSeconds: 5 },
            modelLimits: { a: { concurrency: 2 } },
          },
        ],
      },
    } as unknown as AppConfig;
    expect(resolveModelLimits(appConfig, ENDPOINT, 'large')).toEqual({
      concurrency: 1,
      maxWaitSeconds: 30,
    });
    expect(resolveModelLimits(appConfig, ENDPOINT, 'other')).toBeUndefined();
    expect(resolveModelLimits(appConfig, 'Shared', 'a')).toEqual({
      concurrency: 2,
      pauseSeconds: 5,
    });
    expect(resolveModelLimits(appConfig, 'Shared', 'b')).toEqual({
      concurrency: 4,
      pauseSeconds: 5,
    });
    expect(queueKey(ENDPOINT, 'large')).not.toBe(queueKey(ENDPOINT, 'small'));
  });

  it('sums prompt token counts and usage rows', () => {
    expect(sumTokenCounts({ 0: 120, 1: 30, 2: undefined })).toBe(150);
    expect(summarizeTurnUsage([{ input_tokens: 10, output_tokens: 5 }, null, {}])).toEqual({
      tokens: 15,
      requests: 2,
    });
  });

  it('counts only non-error parts as streamed content', () => {
    expect(hasStreamedContent(undefined)).toBe(false);
    expect(hasStreamedContent([{ type: 'error', error: 'x' }, null])).toBe(false);
    expect(hasStreamedContent([{ type: 'tool_call' }])).toBe(true);
  });

  it('writes a timeout as fallback prose followed by the typed payload', () => {
    const [prose, payload] = getProviderQueueErrorText().split('\n');
    expect(prose).toMatch(/overloaded/);
    expect(JSON.parse(payload)).toEqual({ type: ErrorTypes.QUEUE_TIMEOUT });
    expect(QueueEvents.ON_QUEUE_STATUS).toBe('on_queue_status');
  });
});

describe('queues per model', () => {
  it('queues two models of one provider independently', async () => {
    const appConfig = {
      endpoints: {
        custom: [
          {
            name: ENDPOINT,
            modelLimits: { large: { concurrency: 1 }, small: { concurrency: 1 } },
          },
        ],
      },
    } as unknown as AppConfig;
    const { turn } = setup(undefined, appConfig);
    const first = pending();
    const large = turn(first.run, { model: 'large' });
    await flush();

    const statuses: TQueueStatusEvent[] = [];
    let secondRan = false;
    const secondLarge = turn(
      async () => {
        secondRan = true;
        return 'large-2';
      },
      { model: 'large', statuses },
    );
    const small = turn(async () => 'small', { model: 'small' });
    await flush();

    /** The other model runs at once; the same model waits for the first turn's slot. */
    await expect(small).resolves.toBe('small');
    expect(secondRan).toBe(false);
    expect(statuses[0]).toMatchObject({ queued: true, position: 1, reason: 'provider_busy' });

    first.finish('large-1');
    await expect(large).resolves.toBe('large-1');
    await expect(secondLarge).resolves.toBe('large-2');
  });

  it('runs a model without limits directly while another model of the provider is full', async () => {
    const appConfig = {
      endpoints: { custom: [{ name: ENDPOINT, modelLimits: { large: { concurrency: 1 } } }] },
    } as unknown as AppConfig;
    const { turn } = setup(undefined, appConfig);
    const first = pending();
    const large = turn(first.run, { model: 'large' });
    await flush();
    await expect(turn(async () => 'free', { model: 'unlimited' })).resolves.toBe('free');
    first.finish('done');
    await expect(large).resolves.toBe('done');
  });
});
