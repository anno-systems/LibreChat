import { EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { AdminPricingDeps } from './pricing';
import type { ServerRequest } from '~/types/http';

const mockLoggerError = jest.fn();
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}));
jest.mock('~/cache', () => ({
  tokenConfigCache: jest.fn(() => ({ get: async () => undefined })),
}));

import { createAdminPricingHandler } from './pricing';

/** The tenant hides costs in chat; the admin dashboard still needs the rates. */
const tenantConfig = {
  interfaceConfig: { contextCost: false },
  endpoints: {
    [EModelEndpoint.custom]: [
      {
        name: 'Mistral EU',
        tokenConfig: {
          'mistral-small-latest': { prompt: 0.1, completion: 0.3, context: 32000 },
          'half-priced': { prompt: 0.5, context: 8000 },
        },
      },
    ],
  },
} as unknown as AppConfig;

function setup(overrides: Partial<AdminPricingDeps> = {}) {
  const deps: AdminPricingDeps = {
    getTenantAppConfig: jest.fn().mockResolvedValue(tenantConfig),
    getModelsConfig: jest.fn().mockResolvedValue({
      openAI: ['gpt-4o'],
      'Mistral EU': ['mistral-small-latest', 'half-priced'],
      google: [],
    }),
    getValueKey: jest.fn(() => 'value-key'),
    getMultiplier: jest.fn(({ tokenType }) => (tokenType === 'prompt' ? 2.5 : 10)),
    getCacheMultiplier: jest.fn(() => 1.25),
    ...overrides,
  };
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return { deps, res, handler: createAdminPricingHandler(deps) };
}

const adminReq = (tenantId?: string) =>
  ({ user: { id: 'admin-1', tenantId }, query: {} }) as unknown as ServerRequest;

describe('createAdminPricingHandler', () => {
  beforeEach(() => mockLoggerError.mockReset());

  it("lists the tenant's models with USD per 1M tokens, even with contextCost off", async () => {
    const { deps, res, handler } = setup();
    const req = adminReq('tenant-a');

    await handler(req, res as unknown as Response);

    expect(deps.getTenantAppConfig).toHaveBeenCalledWith('tenant-a');
    expect(deps.getModelsConfig).toHaveBeenCalledWith(req);
    expect(req.config).toBe(tenantConfig);
    expect(res.json).toHaveBeenCalledWith({
      models: [
        { endpoint: 'Mistral EU', model: 'half-priced', prompt: 0.5, completion: null },
        { endpoint: 'Mistral EU', model: 'mistral-small-latest', prompt: 0.1, completion: 0.3 },
        { endpoint: 'openAI', model: 'gpt-4o', prompt: 2.5, completion: 10 },
      ],
    });
    expect(deps.getMultiplier).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o', endpoint: 'openAI', tokenType: 'completion' }),
    );
    expect(tenantConfig.interfaceConfig?.contextCost).toBe(false);
  });

  it("adds the tenant's search price and display currency from platform pricing", async () => {
    const resolvePricing = jest.fn(() => ({
      searchPer1000: 2,
      currency: { code: 'EUR', rate: 0.92 },
    }));
    const { res, handler } = setup({ resolvePricing });
    await handler(adminReq('tenant-a'), res as unknown as Response);

    expect(resolvePricing).toHaveBeenCalledWith('tenant-a');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        search: { per1000: 2 },
        currency: { code: 'EUR', rate: 0.92 },
      }),
    );
  });

  it("adds the page fetch price and the operator's page cap per search", async () => {
    const resolvePricing = jest.fn(() => ({
      searchPer1000: 2,
      fetchPer1000: 4,
      maxPagesPerSearch: 3,
      currency: { code: 'EUR', rate: 0.92 },
    }));
    const { res, handler } = setup({ resolvePricing });
    await handler(adminReq('tenant-a'), res as unknown as Response);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        search: { per1000: 2 },
        fetch: { per1000: 4, maxPagesPerSearch: 3 },
      }),
    );
  });

  it('sends the default page cap with a fetch price, and models only without prices', async () => {
    const priced = setup({ resolvePricing: () => ({ searchPer1000: 0, fetchPer1000: 4 }) });
    await priced.handler(adminReq('tenant-a'), priced.res as unknown as Response);
    const unpriced = setup({
      resolvePricing: () => ({ searchPer1000: 0, fetchPer1000: 0, maxPagesPerSearch: 3 }),
    });
    await unpriced.handler(adminReq('tenant-a'), unpriced.res as unknown as Response);

    const body = priced.res.json.mock.calls[0][0];
    expect(Object.keys(body)).toEqual(['models', 'fetch']);
    expect(body.fetch).toEqual({ per1000: 4, maxPagesPerSearch: 5 });
    expect(Object.keys(unpriced.res.json.mock.calls[0][0])).toEqual(['models']);
  });

  it('answers an empty list when the tenant offers no models', async () => {
    const { res, handler } = setup({ getModelsConfig: jest.fn().mockResolvedValue({}) });

    await handler(adminReq('tenant-a'), res as unknown as Response);

    expect(res.json).toHaveBeenCalledWith({ models: [] });
  });

  it('refuses a caller without a tenant', async () => {
    const { deps, res, handler } = setup();

    await handler(adminReq(undefined), res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'tenant_required' });
    expect(deps.getTenantAppConfig).not.toHaveBeenCalled();
  });

  it('answers 500 with a generic message and keeps the error text out of the response', async () => {
    const { res, handler } = setup({
      getModelsConfig: jest.fn().mockRejectedValue(new Error('provider key sk-secret rejected')),
    });

    await handler(adminReq('tenant-a'), res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to load model rates' });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('sk-secret');
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[adminPricing] Failed to load model rates',
      expect.anything(),
    );
  });
});
