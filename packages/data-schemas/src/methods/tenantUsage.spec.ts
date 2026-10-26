import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createTenantUsageMethods } from './tenantUsage';
import { tenantStorage } from '../config/tenantContext';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createTenantUsageMethods>;

const now = new Date('2026-10-21T12:00:00Z');
const daysAgo = (days: number, hour = 10) => new Date(Date.UTC(2026, 9, 21 - days, hour, 0, 0));
const userA = new mongoose.Types.ObjectId();
const userB = new mongoose.Types.ObjectId();
let seq = 0;

const message = (tenantId: string, user: string, createdAt: Date, isCreatedByUser: boolean) => ({
  tenantId,
  messageId: `m${++seq}`,
  conversationId: `c-${tenantId}`,
  user,
  isCreatedByUser,
  model: isCreatedByUser ? null : 'Mistral-Large-3',
  createdAt,
  updatedAt: createdAt,
});

const transaction = (tenantId: string, tokenType: string, rawAmount: number, createdAt: Date) => ({
  tenantId,
  user: userA,
  tokenType,
  rawAmount,
  model: 'Mistral-Large-3',
  createdAt,
  updatedAt: createdAt,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createTenantUsageMethods(mongoose);

  const a = userA.toString();
  const b = userB.toString();
  await mongoose.models.Message.collection.insertMany([
    message('tenant-a', a, daysAgo(0), true),
    message('tenant-a', a, daysAgo(0), false),
    message('tenant-a', b, daysAgo(0), true),
    message('tenant-a', a, daysAgo(2), true),
    message('tenant-a', a, daysAgo(2), false),
    // Outside a 7-day window.
    message('tenant-a', b, daysAgo(20), true),
    // Another tenant.
    message('tenant-b', a, daysAgo(0), true),
  ]);
  await mongoose.models.Conversation.collection.insertMany([
    { tenantId: 'tenant-a', conversationId: 'c1', user: a, createdAt: daysAgo(0) },
    { tenantId: 'tenant-a', conversationId: 'c2', user: b, createdAt: daysAgo(2) },
    { tenantId: 'tenant-b', conversationId: 'c3', user: a, createdAt: daysAgo(0) },
  ]);
  await mongoose.models.Transaction.collection.insertMany([
    transaction('tenant-a', 'prompt', -1200, daysAgo(0)),
    transaction('tenant-a', 'completion', -300, daysAgo(0)),
    transaction('tenant-a', 'credits', -5000, daysAgo(0)),
    transaction('tenant-b', 'prompt', -9999, daysAgo(0)),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const usage = (tenantId: string, days: 7 | 30 | 90) =>
  tenantStorage.run({ tenantId }, () =>
    methods.getTenantUsage({ tenantId, days, timeZone: 'Europe/Berlin', now }),
  );

describe('getTenantUsage', () => {
  it("sums the tenant's messages, users, conversations and tokens in the window", async () => {
    const result = await usage('tenant-a', 7);

    expect(result.totals).toEqual({
      activeUsers: 2,
      messages: 3,
      conversations: 2,
      promptTokens: 1200,
      completionTokens: 300,
    });
    expect(result.models).toEqual([
      { model: 'Mistral-Large-3', replies: 2, promptTokens: 1200, completionTokens: 300 },
    ]);
  });

  it('returns one row per day, oldest first, with empty days filled in', async () => {
    const result = await usage('tenant-a', 7);

    expect(result.daily).toHaveLength(7);
    expect(result.from).toBe('2026-10-15');
    expect(result.to).toBe('2026-10-21');
    expect(result.daily[result.daily.length - 1]).toEqual({
      date: '2026-10-21',
      activeUsers: 2,
      messages: 2,
      conversations: 1,
    });
    expect(result.daily[result.daily.length - 3]).toMatchObject({
      date: '2026-10-19',
      messages: 1,
      activeUsers: 1,
    });
    expect(result.daily[0]).toMatchObject({ messages: 0, activeUsers: 0, conversations: 0 });
  });

  it('widens with the range and never includes another tenant', async () => {
    expect((await usage('tenant-a', 30)).totals.messages).toBe(4);
    expect((await usage('tenant-b', 7)).totals).toEqual({
      activeUsers: 1,
      messages: 1,
      conversations: 1,
      promptTokens: 9999,
      completionTokens: 0,
    });
  });

  it("names the tenant's agents among the models", async () => {
    const a = userA.toString();
    await mongoose.models.Message.collection.insertMany([
      { ...message('tenant-c', a, daysAgo(0), false), model: 'agent_support' },
      { ...message('tenant-c', a, daysAgo(0), false), model: 'agent_gone' },
    ]);
    await mongoose.models.Agent.collection.insertMany([
      { tenantId: 'tenant-c', id: 'agent_support', name: 'Support' },
      { tenantId: 'tenant-d', id: 'agent_gone', name: 'Another tenant' },
    ]);

    const { models } = await usage('tenant-c', 7);

    expect(models).toEqual([
      { model: 'agent_gone', replies: 1, promptTokens: 0, completionTokens: 0 },
      {
        model: 'agent_support',
        agentName: 'Support',
        replies: 1,
        promptTokens: 0,
        completionTokens: 0,
      },
    ]);
  });

  it('carries no user ids or names', async () => {
    const result = JSON.stringify(await usage('tenant-a', 30));

    expect(result).not.toContain(userA.toString());
    expect(result).not.toContain(userB.toString());
  });
});
