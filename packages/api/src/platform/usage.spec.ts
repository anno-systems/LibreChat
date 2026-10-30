import { logger } from '@librechat/data-schemas';
import type { PlatformUsage } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import { createPlatformUsageHandler, createSignInRecorder } from './usage';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const usage: PlatformUsage = {
  from: '2026-10-15',
  to: '2026-10-21',
  days: 7,
  timeZone: 'UTC',
  totals: {
    users: 3,
    agents: 2,
    activeUsers: 2,
    signIns: 4,
    messages: 9,
    promptTokens: 100,
    completionTokens: 50,
    webSearches: 1,
  },
  daily: [],
};

function respond() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

function call(
  query: Record<string, unknown>,
  getPlatformUsage = jest.fn().mockResolvedValue(usage),
) {
  const res = respond();
  const done = createPlatformUsageHandler({ getPlatformUsage })(
    { query } as unknown as Request,
    res as unknown as Response,
  );
  return { done, res, getPlatformUsage };
}

describe('createPlatformUsageHandler', () => {
  it('answers the platform usage, 30 days by default', async () => {
    const { done, res, getPlatformUsage } = call({ timeZone: 'Europe/Berlin' });
    await done;

    expect(getPlatformUsage).toHaveBeenCalledWith({ days: 30, timeZone: 'Europe/Berlin' });
    expect(res.json).toHaveBeenCalledWith(usage);
  });

  it('passes the period and drops a malformed time zone', async () => {
    const { done, getPlatformUsage } = call({ days: '90', timeZone: 'Europe/Berlin; drop' });
    await done;

    expect(getPlatformUsage).toHaveBeenCalledWith({ days: 90, timeZone: undefined });
  });

  it('refuses other periods', async () => {
    for (const days of ['365', '0', 'all', ['7', '30']]) {
      const { done, res, getPlatformUsage } = call({ days });
      await done;
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'invalid_days' });
      expect(getPlatformUsage).not.toHaveBeenCalled();
    }
  });

  it('answers a failure without its cause', async () => {
    const { done, res } = call(
      {},
      jest.fn().mockRejectedValue(new Error('connection to mongo-1 refused')),
    );
    await done;

    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('mongo-1');
  });
});

describe('createSignInRecorder', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it("records the user's tenant only", async () => {
    const recordPlatformSignIn = jest.fn().mockResolvedValue(undefined);
    const record = createSignInRecorder({ enabled: true, recordPlatformSignIn });

    record({ tenantId: 'tenant-a', email: 'a@a.test' } as { tenantId: string });
    record({});
    record(null);

    expect(recordPlatformSignIn.mock.calls).toEqual([
      [{ tenantId: 'tenant-a' }],
      [{ tenantId: undefined }],
    ]);
  });

  it('records nothing while disabled', () => {
    const recordPlatformSignIn = jest.fn().mockResolvedValue(undefined);
    createSignInRecorder({ enabled: false, recordPlatformSignIn })({ tenantId: 'tenant-a' });
    expect(recordPlatformSignIn).not.toHaveBeenCalled();
  });

  it('logs a failed write instead of throwing', async () => {
    const record = createSignInRecorder({
      enabled: true,
      recordPlatformSignIn: jest.fn().mockRejectedValue(new Error('mongo down')),
    });

    expect(() => record({ tenantId: 'tenant-a' })).not.toThrow();
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(
      '[platformUsage] Failed to record a sign-in',
      expect.anything(),
    );
  });
});
