import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createAdminUsageHandler } from './usage';

const usage = {
  from: '2026-10-15',
  to: '2026-10-21',
  days: 7,
  totals: { activeUsers: 1, messages: 2, conversations: 1, promptTokens: 10, completionTokens: 5 },
  daily: [],
  models: [],
};

function call(query: Record<string, unknown>, tenantId?: string) {
  const getTenantUsage = jest.fn().mockResolvedValue(usage);
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  const req = { user: tenantId ? { tenantId } : {}, query } as unknown as ServerRequest;
  const done = createAdminUsageHandler({ getTenantUsage })(req, res as unknown as Response);
  return { done, res, getTenantUsage };
}

describe('createAdminUsageHandler', () => {
  it("answers with the caller's tenant usage, 30 days by default", async () => {
    const { done, res, getTenantUsage } = call({ timeZone: 'Europe/Berlin' }, 'tenant-a');
    await done;

    expect(getTenantUsage).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      days: 30,
      timeZone: 'Europe/Berlin',
    });
    expect(res.json).toHaveBeenCalledWith(usage);
  });

  it('refuses other ranges and callers without a tenant', async () => {
    const bad = call({ days: '365' }, 'tenant-a');
    await bad.done;
    expect(bad.res.status).toHaveBeenCalledWith(400);
    expect(bad.getTenantUsage).not.toHaveBeenCalled();

    const none = call({ days: '7' });
    await none.done;
    expect(none.res.status).toHaveBeenCalledWith(400);
  });

  it('answers a failure without its cause', async () => {
    const { res } = call({}, 'tenant-a');
    const failing = createAdminUsageHandler({
      getTenantUsage: jest.fn().mockRejectedValue(new Error('connection to mongo-1 refused')),
    });
    await failing(
      { user: { tenantId: 'tenant-a' }, query: {} } as unknown as ServerRequest,
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('mongo-1');
  });
});
