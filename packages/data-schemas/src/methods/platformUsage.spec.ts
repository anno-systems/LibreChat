import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createPlatformUsageMethods } from './platformUsage';
import { tenantStorage } from '../config/tenantContext';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createPlatformUsageMethods>;

const now = new Date('2026-10-21T12:00:00Z');
const daysAgo = (days: number, hour = 10) => new Date(Date.UTC(2026, 9, 21 - days, hour, 0, 0));
const userA = new mongoose.Types.ObjectId();
const userB = new mongoose.Types.ObjectId();
const userC = new mongoose.Types.ObjectId();
let seq = 0;

/** An ObjectId as the server would have made it at `createdAt`. */
const idAt = (createdAt: Date) =>
  new mongoose.Types.ObjectId(
    mongoose.Types.ObjectId.createFromTime(Math.floor(createdAt.getTime() / 1000))
      .toHexString()
      .slice(0, 8) + new mongoose.Types.ObjectId().toHexString().slice(8),
  );

const message = (
  tenantId: string,
  user: mongoose.Types.ObjectId,
  createdAt: Date,
  isCreatedByUser: boolean,
  content?: unknown[],
) => ({
  _id: idAt(createdAt),
  tenantId,
  messageId: `m${++seq}`,
  conversationId: `c-${tenantId}`,
  user: user.toString(),
  isCreatedByUser,
  ...(content && { content }),
  createdAt,
  updatedAt: createdAt,
});

const search = { type: 'tool_call', tool_call: { id: 's', name: 'web_search', args: '{}' } };
const otherTool = { type: 'tool_call', tool_call: { id: 'o', name: 'calculator', args: '{}' } };
const text = { type: 'text', text: 'answer' };

const transaction = (tenantId: string, tokenType: string, rawAmount: number, createdAt: Date) => ({
  _id: idAt(createdAt),
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
  methods = createPlatformUsageMethods(mongoose);

  await mongoose.models.User.collection.insertMany([
    { _id: userA, tenantId: 'tenant-a', email: 'a@a.test', provider: 'openid' },
    { _id: userB, tenantId: 'tenant-a', email: 'b@a.test', provider: 'openid' },
    { _id: userC, tenantId: 'tenant-b', email: 'c@b.test', provider: 'openid' },
  ]);
  await mongoose.models.Agent.collection.insertMany([
    { id: 'agent_1', tenantId: 'tenant-a', name: 'One', author: userA },
    { id: 'agent_2', tenantId: 'tenant-b', name: 'Two', author: userC },
    // A copy of a platform agent is not counted.
    { id: 'agent_3', tenantId: 'tenant-b', name: 'Support', platformAgentId: 'support' },
  ]);
  await mongoose.models.Message.collection.insertMany([
    message('tenant-a', userA, daysAgo(0), true),
    message('tenant-a', userA, daysAgo(0), false, [text, search, search, otherTool]),
    message('tenant-a', userB, daysAgo(0), true),
    message('tenant-b', userC, daysAgo(0), true),
    message('tenant-b', userC, daysAgo(0), false, [search]),
    message('tenant-a', userA, daysAgo(2), true),
    message('tenant-b', userA, daysAgo(2), true),
    // Outside a 7-day window.
    message('tenant-a', userB, daysAgo(20), true),
    message('tenant-a', userB, daysAgo(20), false, [search]),
  ]);
  await mongoose.models.Transaction.collection.insertMany([
    transaction('tenant-a', 'prompt', -1200, daysAgo(0)),
    transaction('tenant-a', 'completion', -300, daysAgo(0)),
    transaction('tenant-a', 'credits', -5000, daysAgo(0)),
    transaction('tenant-b', 'prompt', -800, daysAgo(0)),
    transaction('tenant-b', 'completion', -200, daysAgo(1)),
    transaction('tenant-b', 'prompt', -9999, daysAgo(20)),
  ]);
  await methods.recordPlatformSignIn({ tenantId: 'tenant-a', at: daysAgo(0) });
  await methods.recordPlatformSignIn({ tenantId: 'tenant-b', at: daysAgo(0) });
  await methods.recordPlatformSignIn({ tenantId: 'tenant-b', at: daysAgo(3) });
  await methods.recordPlatformSignIn({ at: daysAgo(30) });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('getPlatformUsage', () => {
  it('sums every tenant per day and in total', async () => {
    const usage = await methods.getPlatformUsage({ days: 7, now });

    expect(usage.from).toBe('2026-10-15');
    expect(usage.to).toBe('2026-10-21');
    expect(usage.timeZone).toBe('UTC');
    expect(usage.daily).toHaveLength(7);
    expect(usage.totals).toEqual({
      users: 3,
      agents: 2,
      activeUsers: 3,
      signIns: 3,
      messages: 5,
      promptTokens: 2000,
      completionTokens: 500,
      webSearches: 3,
    });
    expect(usage.daily.find((d) => d.date === '2026-10-21')).toEqual({
      date: '2026-10-21',
      signIns: 2,
      activeUsers: 3,
      messages: 3,
      promptTokens: 2000,
      completionTokens: 300,
      webSearches: 3,
    });
    expect(usage.daily.find((d) => d.date === '2026-10-19')).toMatchObject({
      activeUsers: 1,
      messages: 2,
    });
    expect(usage.daily.find((d) => d.date === '2026-10-20')).toMatchObject({
      completionTokens: 200,
    });
    expect(usage.daily.find((d) => d.date === '2026-10-18')).toMatchObject({ signIns: 1 });
  });

  it('includes older days in a longer period', async () => {
    const usage = await methods.getPlatformUsage({ days: 30, now });

    expect(usage.daily).toHaveLength(30);
    expect(usage.totals).toMatchObject({
      messages: 6,
      webSearches: 4,
      promptTokens: 11999,
      signIns: 3,
    });
    expect(usage.daily.find((d) => d.date === '2026-10-01')).toMatchObject({
      messages: 1,
      activeUsers: 1,
    });
  });

  it('reads across tenants from inside a tenant context too', async () => {
    const usage = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      methods.getPlatformUsage({ days: 7, now }),
    );
    expect(usage.totals.users).toBe(3);
    expect(usage.totals.messages).toBe(5);
  });

  it('counts days in the requested time zone and falls back to UTC', async () => {
    const late = await methods.getPlatformUsage({ days: 7, now, timeZone: 'Pacific/Kiritimati' });
    expect(late.to).toBe('2026-10-22');
    expect(late.daily.find((d) => d.date === '2026-10-22')?.messages).toBe(3);

    const invalid = await methods.getPlatformUsage({ days: 7, now, timeZone: 'Not/AZone' });
    expect(invalid.timeZone).toBe('UTC');
  });

  it('keeps no user on a sign-in and expires them', async () => {
    const doc = await mongoose.models.PlatformSignIn.findOne({ tenantId: 'tenant-a' }).lean();
    expect(Object.keys(doc ?? {}).sort()).toEqual(['__v', '_id', 'createdAt', 'tenantId']);
    await mongoose.models.PlatformSignIn.init();
    const indexes = await mongoose.models.PlatformSignIn.collection.indexes();
    expect(indexes.find((i) => i.key.createdAt === 1)?.expireAfterSeconds).toBe(100 * 86400);
  });
});
