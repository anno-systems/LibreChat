import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { tenantStorage } from '../config/tenantContext';
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
  await methods.setPlatformPricing({
    scope: 'default',
    tokenMarkup: 0.15,
    searchPer1000: 2,
    currency: { code: 'EUR', rate: 0.92 },
  });
  await methods.setPlatformPricing({ scope: 'tenant-big', tokenMarkup: 0 });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const charge = (tenantId: string, tokenType: 'prompt' | 'completion', rawAmount: number) =>
  tenantStorage.run({ tenantId }, () =>
    methods.createTransaction({
      user,
      tokenType,
      rawAmount,
      model: 'eu-model',
      endpointTokenConfig: tokenConfig,
      context: 'message',
    }),
  );

const lastTransaction = (tenantId: string) =>
  tenantStorage.run({ tenantId }, () =>
    mongoose.models.Transaction.findOne({ tenantId }).sort({ _id: -1 }).lean<{
      rate: number;
      tokenValue: number;
    }>(),
  );

describe('ledger with platform pricing', () => {
  it("charges the tenant's token rates with the markup", async () => {
    await charge('tenant-a', 'completion', -1000);
    const tx = await lastTransaction('tenant-a');

    expect(tx?.rate).toBeCloseTo(6.9);
    expect(tx?.tokenValue).toBeCloseTo(-6900);
  });

  it("charges a tenant's override instead of the default", async () => {
    await charge('tenant-big', 'prompt', -1000);
    const tx = await lastTransaction('tenant-big');

    expect(tx?.rate).toBe(2);
    expect(tx?.tokenValue).toBe(-2000);
  });

  it('leaves credit transactions as they are', async () => {
    await tenantStorage.run({ tenantId: 'tenant-c' }, () =>
      methods.createTransaction({
        user,
        tokenType: 'credits',
        context: 'web_search',
        rawAmount: -methods.webSearchCredits('tenant-c'),
      }),
    );
    const tx = await lastTransaction('tenant-c');

    expect(tx?.tokenValue).toBe(-2174);
  });
});
