import type { PlatformPricing } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import { createPlatformPricingHandlers, withPricingCurrency } from './pricing';
import { createWebSearchCharge, countFetchedPages } from './searchCharge';

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    end() {
      return res;
    },
  };
  return res as typeof res & Response;
}

const req = (body: unknown = {}, tenantId?: string) =>
  ({ params: tenantId ? { tenantId } : {}, body }) as unknown as Request;

function setup() {
  const stored = new Map<string, PlatformPricing>();
  const store = {
    listPlatformPricing: jest.fn(async () => [...stored.values()]),
    setPlatformPricing: jest.fn(async (pricing: PlatformPricing) => {
      stored.set(pricing.scope, pricing);
      return pricing;
    }),
    deletePlatformPricing: jest.fn(async (scope: string) => stored.delete(scope)),
  };
  return { store, stored, handlers: createPlatformPricingHandlers(store) };
}

const EUR = { code: 'EUR', rate: 0.92 };

describe('platform pricing handlers', () => {
  it('saves the default with its currency and lists it with the overrides', async () => {
    const { handlers } = setup();
    await handlers.putDefaultPricing(
      req({ tokenMarkup: 0.15, searchPer1000: 2, currency: EUR }),
      mockRes(),
    );
    await handlers.putTenantPricing(req({ tokenMarkup: 0.05 }, 'tenant-big'), mockRes());

    const res = mockRes();
    await handlers.getPricing(req(), res);

    expect(res.body).toEqual({
      default: { tokenMarkup: 0.15, searchPer1000: 2, currency: EUR },
      tenants: [{ tenantId: 'tenant-big', tokenMarkup: 0.05 }],
    });
  });

  it('saves a page fetch price and a page cap, as default and per tenant', async () => {
    const { handlers, store } = setup();
    const saved = mockRes();
    await handlers.putDefaultPricing(
      req({ searchPer1000: 2, fetchPer1000: 1, maxPagesPerSearch: 3, currency: EUR }),
      saved,
    );
    const tenant = mockRes();
    await handlers.putTenantPricing(req({ maxPagesPerSearch: 0 }, 'tenant-small'), tenant);

    expect(saved.body).toEqual({
      pricing: { searchPer1000: 2, fetchPer1000: 1, maxPagesPerSearch: 3, currency: EUR },
    });
    expect(tenant.body).toEqual({ pricing: { tenantId: 'tenant-small', maxPagesPerSearch: 0 } });
    expect(store.setPlatformPricing).toHaveBeenLastCalledWith({
      scope: 'tenant-small',
      maxPagesPerSearch: 0,
    });
  });

  it('answers an empty default before the operator sets prices', async () => {
    const { handlers } = setup();
    const res = mockRes();
    await handlers.getPricing(req(), res);

    expect(res.body).toEqual({ default: {}, tenants: [] });
  });

  it.each([
    [{ tokenMarkup: -0.1 }],
    [{ tokenMarkup: 11 }],
    [{ searchPer1000: 'two' }],
    [{ fetchPer1000: -1 }],
    [{ maxPagesPerSearch: 2.5 }],
    [{ maxPagesPerSearch: -1 }],
    [{ maxPagesPerSearch: 11 }],
    [{ currency: { code: 'eur', rate: 0.92 } }],
    [{ currency: { code: 'EUR', rate: 0 } }],
    [{ unknown: true }],
  ])('refuses an invalid default %j', async (body) => {
    const { handlers, store } = setup();
    const res = mockRes();
    await handlers.putDefaultPricing(req(body), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_pricing' });
    expect(store.setPlatformPricing).not.toHaveBeenCalled();
  });

  it('keeps the currency for the default only', async () => {
    const { handlers, store } = setup();
    const res = mockRes();
    await handlers.putTenantPricing(req({ currency: EUR }, 'tenant-a'), res);

    expect(res.statusCode).toBe(400);
    expect(store.setPlatformPricing).not.toHaveBeenCalled();
  });

  it('refuses tenant ids that are invalid or name the default', async () => {
    const { handlers } = setup();
    for (const tenantId of ['default', '../x', '']) {
      const res = mockRes();
      await handlers.putTenantPricing(req({ tokenMarkup: 0.1 }, tenantId), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_tenant_id' });
    }
  });

  it('removes an override and answers 404 for a tenant without one', async () => {
    const { handlers } = setup();
    await handlers.putTenantPricing(req({ tokenMarkup: 0.05 }, 'tenant-big'), mockRes());

    const removed = mockRes();
    await handlers.deleteTenantPricing(req({}, 'tenant-big'), removed);
    const missing = mockRes();
    await handlers.deleteTenantPricing(req({}, 'tenant-big'), missing);

    expect(removed.statusCode).toBe(204);
    expect(missing.statusCode).toBe(404);
  });

  it('answers 500 without the store error', async () => {
    const { handlers, store } = setup();
    store.listPlatformPricing.mockRejectedValueOnce(new Error('mongo: secret detail'));
    const res = mockRes();
    await handlers.getPricing(req(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
  });
});

describe('withPricingCurrency', () => {
  it("sets the operator's currency on the interface", () => {
    const config: { contextCost?: boolean; currency?: typeof EUR } = { contextCost: true };
    expect(withPricingCurrency(config, EUR)).toEqual({
      contextCost: true,
      currency: EUR,
    });
  });

  it('leaves the interface as configured without platform pricing', () => {
    const config = { currency: { code: 'USD', rate: 1 } };
    expect(withPricingCurrency(config, undefined)).toBe(config);
    expect(withPricingCurrency(undefined, EUR)).toBeUndefined();
  });
});

describe('createWebSearchCharge', () => {
  const request = {
    user: { id: 'user-1', tenantId: 'tenant-a' },
    config: { balance: { enabled: true } },
  };

  it("writes one web_search debit at the tenant's search price", async () => {
    const createTransaction = jest.fn(async () => undefined);
    const webSearchCredits = jest.fn(() => 2174);
    await createWebSearchCharge({ webSearchCredits, createTransaction })(request, 'convo-1');

    expect(webSearchCredits).toHaveBeenCalledWith('tenant-a');
    expect(createTransaction).toHaveBeenCalledWith({
      user: 'user-1',
      tokenType: 'credits',
      context: 'web_search',
      rawAmount: -2174,
      conversationId: 'convo-1',
      balance: { enabled: true },
      transactions: undefined,
    });
  });

  it('writes nothing without a search price or a user', async () => {
    const createTransaction = jest.fn(async () => undefined);
    await createWebSearchCharge({ webSearchCredits: () => 0, createTransaction })(request);
    await createWebSearchCharge({ webSearchCredits: () => 2174, createTransaction })({});

    expect(createTransaction).not.toHaveBeenCalled();
  });

  /** A `web_search` artifact: two fetched pages, one also a top story, and snippet-only results. */
  const artifact = {
    organic: [
      { link: 'https://a.example', snippet: 'a', highlights: [{ text: 'a', score: 1 }] },
      { link: 'https://b.example', snippet: 'b', highlights: [{ text: 'b', score: 1 }] },
      { link: 'https://c.example', snippet: 'c' },
      { link: 'https://d.example', snippet: 'd', highlights: [] },
    ],
    topStories: [{ link: 'https://b.example', highlights: [{ text: 'b', score: 1 }] }],
  };

  it('writes one web_scrape debit per fetched page at the page price', async () => {
    const createTransaction = jest.fn(async (_tx: { context: string; rawAmount: number }) => {});
    const charge = createWebSearchCharge({
      webSearchCredits: () => 2174,
      webFetchCredits: () => 1087,
      maxPagesPerSearch: () => 5,
      createTransaction,
    });
    await charge(request, 'convo-1', artifact);

    expect(createTransaction.mock.calls.map(([tx]) => [tx.context, tx.rawAmount])).toEqual([
      ['web_search', -2174],
      ['web_scrape', -1087],
      ['web_scrape', -1087],
    ]);
    expect(createTransaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ user: 'user-1', conversationId: 'convo-1', tokenType: 'credits' }),
    );
  });

  it("charges no more pages than the operator's cap or the scope's lower limit", async () => {
    const createTransaction = jest.fn(async (_tx: { context: string }) => {});
    const deps = { webSearchCredits: () => 0, webFetchCredits: () => 1087, createTransaction };
    await createWebSearchCharge({ ...deps, maxPagesPerSearch: () => 1 })(request, 'c', artifact);
    await createWebSearchCharge({ ...deps, maxPagesPerSearch: () => 5 })(
      { ...request, config: { webSearch: { maxPagesPerSearch: 0 } } },
      'c',
      artifact,
    );

    expect(createTransaction.mock.calls.map(([tx]) => tx.context)).toEqual(['web_scrape']);
  });

  it('charges pages without a search price and nothing for pages without a page price', async () => {
    const createTransaction = jest.fn(async (_tx: { context: string }) => {});
    await createWebSearchCharge({
      webSearchCredits: () => 0,
      webFetchCredits: () => 1087,
      createTransaction,
    })(request, 'c', artifact);
    await createWebSearchCharge({
      webSearchCredits: () => 2174,
      webFetchCredits: () => 0,
      createTransaction,
    })(request, 'c', artifact);

    expect(createTransaction.mock.calls.map(([tx]) => tx.context)).toEqual([
      'web_scrape',
      'web_scrape',
      'web_search',
    ]);
  });

  it('keeps charging the other debits when one ledger write fails', async () => {
    const createTransaction = jest
      .fn(async (_tx: { context: string }) => {})
      .mockRejectedValueOnce(new Error('write failed'));
    await createWebSearchCharge({
      webSearchCredits: () => 2174,
      webFetchCredits: () => 1087,
      createTransaction,
    })(request, 'c', artifact);

    expect(createTransaction).toHaveBeenCalledTimes(3);
  });

  it('never throws when the ledger write fails', async () => {
    const createTransaction = jest.fn(async () => {
      throw new Error('write failed');
    });
    await expect(
      createWebSearchCharge({ webSearchCredits: () => 2174, createTransaction })(request),
    ).resolves.toBeUndefined();
  });
});

describe('countFetchedPages', () => {
  it('counts distinct links with highlights, up to the limit', () => {
    const result = {
      organic: [
        { link: 'https://a.example', highlights: [{ text: 'a' }] },
        { link: 'https://a.example', highlights: [{ text: 'a' }] },
        { link: 'https://b.example', highlights: [{ text: 'b' }] },
        { link: 'https://c.example' },
      ],
      topStories: [{ link: 'https://d.example', highlights: [{ text: 'd' }] }],
    };

    expect(countFetchedPages(result, 5)).toBe(3);
    expect(countFetchedPages(result, 2)).toBe(2);
    expect(countFetchedPages(result, 0)).toBe(0);
  });

  it('counts nothing for a failed search or anything else', () => {
    expect(countFetchedPages({ organic: [], error: 'Search failed' }, 5)).toBe(0);
    expect(countFetchedPages(undefined, 5)).toBe(0);
    expect(countFetchedPages({ organic: 'x' }, 5)).toBe(0);
  });
});
