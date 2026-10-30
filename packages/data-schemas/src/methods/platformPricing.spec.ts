import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createPlatformPricingMethods, withTokenMarkup } from './platformPricing';
import { SYSTEM_TENANT_ID } from '../config/tenantContext';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.PlatformPricing?.deleteMany({});
});

const EUR = { code: 'EUR', rate: 0.92 };

describe('platform pricing', () => {
  it('charges nothing extra until the operator sets prices', async () => {
    const methods = createPlatformPricingMethods(mongoose);
    await methods.loadPlatformPricing();

    expect(methods.resolvePricing('tenant-a')).toEqual({
      tokenMarkup: 0,
      searchPer1000: 0,
      fetchPer1000: 0,
      maxPagesPerSearch: 5,
    });
    expect(methods.webSearchCredits('tenant-a')).toBe(0);
    expect(methods.webFetchCredits('tenant-a')).toBe(0);
  });

  it('applies the default, a tenant override over it, and the default currency', async () => {
    const methods = createPlatformPricingMethods(mongoose);
    await methods.setPlatformPricing({
      scope: 'default',
      tokenMarkup: 0.15,
      searchPer1000: 2,
      currency: EUR,
    });
    await methods.setPlatformPricing({ scope: 'tenant-big', tokenMarkup: 0.05 });

    expect(methods.resolvePricing('tenant-a')).toEqual({
      tokenMarkup: 0.15,
      searchPer1000: 2,
      fetchPer1000: 0,
      maxPagesPerSearch: 5,
      currency: EUR,
    });
    expect(methods.resolvePricing('tenant-big')).toEqual({
      tokenMarkup: 0.05,
      searchPer1000: 2,
      fetchPer1000: 0,
      maxPagesPerSearch: 5,
      currency: EUR,
    });
    expect(methods.resolvePricing(undefined).tokenMarkup).toBe(0.15);
    expect(methods.resolvePricing(SYSTEM_TENANT_ID).tokenMarkup).toBe(0.15);
  });

  it('prices a web search in credits from the display currency', async () => {
    const methods = createPlatformPricingMethods(mongoose);
    await methods.setPlatformPricing({ scope: 'default', searchPer1000: 2, currency: EUR });

    // 2 EUR / 1000 = 0.002 EUR = 0.002 / 0.92 USD ≈ 2174 credits.
    expect(methods.webSearchCredits('tenant-a')).toBe(2174);
  });

  it('prices a fetched page and caps the pages per search, per tenant over the default', async () => {
    const methods = createPlatformPricingMethods(mongoose);
    await methods.setPlatformPricing({
      scope: 'default',
      fetchPer1000: 1,
      maxPagesPerSearch: 3,
      currency: EUR,
    });
    await methods.setPlatformPricing({ scope: 'tenant-big', maxPagesPerSearch: 0 });

    // 1 EUR / 1000 = 0.001 EUR = 0.001 / 0.92 USD ≈ 1087 credits.
    expect(methods.webFetchCredits('tenant-a')).toBe(1087);
    expect(methods.webSearchCredits('tenant-a')).toBe(0);
    expect(methods.resolvePricing('tenant-a').maxPagesPerSearch).toBe(3);
    expect(methods.resolvePricing('tenant-big').maxPagesPerSearch).toBe(0);
    expect(await methods.listPlatformPricing()).toEqual([
      expect.objectContaining({ scope: 'default', fetchPer1000: 1, maxPagesPerSearch: 3 }),
      { scope: 'tenant-big', maxPagesPerSearch: 0, updatedAt: expect.any(Date) },
    ]);
  });

  it('needs a currency to price searches', async () => {
    const methods = createPlatformPricingMethods(mongoose);
    await methods.setPlatformPricing({ scope: 'default', searchPer1000: 2 });

    expect(methods.webSearchCredits('tenant-a')).toBe(0);
  });

  it('replaces a scope on write and forgets it on delete', async () => {
    const methods = createPlatformPricingMethods(mongoose);
    await methods.setPlatformPricing({ scope: 'tenant-a', tokenMarkup: 0.3, searchPer1000: 1 });
    await methods.setPlatformPricing({ scope: 'tenant-a', tokenMarkup: 0.2 });

    expect(await methods.listPlatformPricing()).toEqual([
      expect.objectContaining({ scope: 'tenant-a', tokenMarkup: 0.2 }),
    ]);
    expect(methods.resolvePricing('tenant-a').searchPer1000).toBe(0);

    expect(await methods.deletePlatformPricing('tenant-a')).toBe(true);
    expect(await methods.deletePlatformPricing('tenant-a')).toBe(false);
    expect(methods.resolvePricing('tenant-a').tokenMarkup).toBe(0);
  });

  it('refuses invalid values', async () => {
    const methods = createPlatformPricingMethods(mongoose);

    await expect(
      methods.setPlatformPricing({ scope: 'default', tokenMarkup: -1 }),
    ).rejects.toThrow();
    await expect(
      methods.setPlatformPricing({ scope: 'default', currency: { code: 'euro', rate: 1 } }),
    ).rejects.toThrow();
    await expect(
      methods.setPlatformPricing({ scope: 'default', maxPagesPerSearch: 2.5 }),
    ).rejects.toThrow();
    await expect(
      methods.setPlatformPricing({ scope: 'default', maxPagesPerSearch: 11 }),
    ).rejects.toThrow();
    await expect(
      methods.setPlatformPricing({ scope: 'default', fetchPer1000: -1 }),
    ).rejects.toThrow();
  });

  it("sees another instance's writes after the refresh interval", async () => {
    let clock = 0;
    const reader = createPlatformPricingMethods(mongoose, { refreshMs: 1000, now: () => clock });
    const writer = createPlatformPricingMethods(mongoose);
    await reader.loadPlatformPricing();
    await writer.setPlatformPricing({ scope: 'default', tokenMarkup: 0.15 });

    expect(reader.resolvePricing('tenant-a').tokenMarkup).toBe(0);
    clock = 2000;
    reader.resolvePricing('tenant-a');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reader.resolvePricing('tenant-a').tokenMarkup).toBe(0.15);
  });
});

describe('withTokenMarkup', () => {
  const rates = {
    getMultiplier: jest.fn(
      ({
        tokenType,
        model,
        valueKey,
      }: {
        tokenType?: string;
        model?: string;
        valueKey?: string;
      }) => (tokenType && (model || valueKey) ? 2 : 1),
    ),
    getCacheMultiplier: jest.fn(({ model }: { model?: string }) =>
      model === 'cached' ? 0.5 : null,
    ),
  };

  it('scales priced token and cache rates by the markup', () => {
    const marked = withTokenMarkup(rates, () => 0.15);

    expect(marked.getMultiplier({ tokenType: 'prompt', model: 'm' })).toBeCloseTo(2.3);
    expect(marked.getMultiplier({ tokenType: 'completion', valueKey: 'k' })).toBeCloseTo(2.3);
    expect(marked.getCacheMultiplier({ model: 'cached' })).toBeCloseTo(0.575);
  });

  it('keeps neutral lookups and missing cache rates as they are', () => {
    const marked = withTokenMarkup(rates, () => 0.15);

    expect(marked.getMultiplier({})).toBe(1);
    expect(marked.getMultiplier({ model: 'm' })).toBe(1);
    expect(marked.getCacheMultiplier({ model: 'plain' })).toBeNull();
  });

  it('reads the markup on every lookup and ignores negative values', () => {
    let markup = 0;
    const marked = withTokenMarkup(rates, () => markup);

    expect(marked.getMultiplier({ tokenType: 'prompt', model: 'm' })).toBe(2);
    markup = 0.5;
    expect(marked.getMultiplier({ tokenType: 'prompt', model: 'm' })).toBe(3);
    markup = -1;
    expect(marked.getMultiplier({ tokenType: 'prompt', model: 'm' })).toBe(2);
  });
});
