import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { runAsSystem, tenantStorage } from '../config/tenantContext';
import { invoiceMonth } from './platformInvoices';
import { createModels } from '../models';
import { createMethods } from './index';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
const user = new mongoose.Types.ObjectId();
const tokenConfig = { 'eu-model': { prompt: 2, completion: 6, context: 32000 } };

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
  await methods.setPlatformPricing({ scope: 'default', tokenMarkup: 0.25 });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const spend = (tenantId: string, rawAmount: number) =>
  tenantStorage.run({ tenantId }, () =>
    methods.createTransaction({
      user,
      tokenType: 'completion',
      rawAmount,
      model: 'eu-model',
      endpointTokenConfig: tokenConfig,
      context: 'message',
    }),
  );

const transactions = (tenantId: string) =>
  tenantStorage.run({ tenantId }, () =>
    mongoose.models.Transaction.find({ tenantId })
      .sort({ _id: 1 })
      .lean<Array<{ tokenType: string; markup?: number; tokenValue: number }>>(),
  );

describe('markup per transaction', () => {
  it('records the markup on token transactions, not on credit transactions', async () => {
    await spend('tenant-a', -1000);
    await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      methods.createTransaction({ user, tokenType: 'credits', rawAmount: 5000, context: 'admin' }),
    );

    const [tokens, credits] = await transactions('tenant-a');
    expect(tokens).toEqual(expect.objectContaining({ tokenType: 'completion', markup: 0.25 }));
    expect(credits?.markup).toBeUndefined();
  });

  it('keeps the markup a transaction was charged with when the markup changes later', async () => {
    await methods.setPlatformPricing({ scope: 'tenant-b', tokenMarkup: 0.1 });
    await spend('tenant-b', -1000);
    await methods.setPlatformPricing({ scope: 'tenant-b', tokenMarkup: 0.5 });
    await spend('tenant-b', -1000);

    expect((await transactions('tenant-b')).map((t) => t.markup)).toEqual([0.1, 0.5]);
  });
});

describe('monthly statement', () => {
  const month = new Date().toISOString().slice(0, 7);

  it("reports each tenant's charges, provider cost and MCP subscriptions of the month", async () => {
    // An old transaction without a recorded markup, estimated with the current one (0.25).
    await runAsSystem(() =>
      mongoose.models.Transaction.collection.insertOne({
        user,
        tenantId: 'tenant-c',
        tokenType: 'prompt',
        tokenValue: -1250,
        createdAt: new Date(),
      }),
    );
    await runAsSystem(() =>
      mongoose.models.Transaction.collection.insertOne({
        user,
        tenantId: 'tenant-c',
        tokenType: 'credits',
        context: 'web_search',
        tokenValue: -2000,
        createdAt: new Date(),
      }),
    );
    await methods.setMcpServerPrice({ server: 'lexware', monthlyPrice: 19, currency: 'EUR' });
    await methods.subscribeMcpServer({
      tenantId: 'tenant-c',
      server: 'lexware',
      consent: { monthlyPrice: 19, currency: 'EUR' },
      acceptedBy: { id: 'admin-c' },
    });

    const statement = await methods.getPlatformInvoices({ month });

    expect(statement.month).toBe(month);
    const byTenant = Object.fromEntries(statement.tenants.map((t) => [t.tenantId, t]));
    expect(Object.keys(byTenant).sort()).toEqual(['tenant-a', 'tenant-b', 'tenant-c']);

    const a = byTenant['tenant-a']!;
    expect(a.estimatedTokenCredits).toBe(0);
    expect(a.providerCredits).toBe(Math.round(a.tokenCredits / 1.25));

    // tenant-b paid at 10 % and 50 %: the provider cost follows each transaction's markup.
    const [b1, b2] = await transactions('tenant-b');
    const b = byTenant['tenant-b']!;
    expect(b.tokenCredits).toBe(Math.round(-b1!.tokenValue - b2!.tokenValue));
    expect(b.providerCredits).toBe(Math.round(-b1!.tokenValue / 1.1 - b2!.tokenValue / 1.5));

    expect(byTenant['tenant-c']).toEqual(
      expect.objectContaining({
        tokenCredits: 1250,
        providerCredits: 1000,
        estimatedTokenCredits: 1250,
        searchCredits: 2000,
        searches: 1,
        mcp: [{ server: 'lexware', price: 19, currency: 'EUR' }],
      }),
    );
  });

  it('leaves out other months and refuses a value that is not a month', async () => {
    const statement = await methods.getPlatformInvoices({ month: '2001-01' });
    expect(statement.tenants).toEqual([]);
    expect(statement.from).toBe('2001-01-01T00:00:00.000Z');
    expect(statement.to).toBe('2001-02-01T00:00:00.000Z');
    await expect(methods.getPlatformInvoices({ month: '2001-13' })).rejects.toThrow();
    expect(invoiceMonth('2024-02')?.lastDay).toBe('2024-02-29');
  });
});
