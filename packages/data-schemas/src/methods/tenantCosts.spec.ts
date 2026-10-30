import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createTenantCostMethods, isCostMonth } from './tenantCosts';
import { tenantStorage } from '../config/tenantContext';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createTenantCostMethods>;

const now = new Date('2026-10-21T12:00:00Z');
const daysAgo = (days: number, hour = 10) => new Date(Date.UTC(2026, 9, 21 - days, hour, 0, 0));
const anna = new mongoose.Types.ObjectId();
const ben = new mongoose.Types.ObjectId();
const external = new mongoose.Types.ObjectId();

const tx = (
  tenantId: string,
  user: mongoose.Types.ObjectId,
  fields: Record<string, unknown>,
  createdAt: Date,
) => ({ tenantId, user, ...fields, createdAt, updatedAt: createdAt });

const prompt = (tokens: number, credits: number) => ({
  tokenType: 'prompt',
  rawAmount: -tokens,
  tokenValue: -credits,
  model: 'mistral-large',
});
const completion = (tokens: number, credits: number, model = 'mistral-large') => ({
  tokenType: 'completion',
  rawAmount: -tokens,
  tokenValue: -credits,
  model,
});
const search = (credits: number) => ({
  tokenType: 'credits',
  context: 'web_search',
  rawAmount: -credits,
  tokenValue: -credits,
});

const fetch = (credits: number) => ({
  tokenType: 'credits',
  context: 'web_scrape',
  rawAmount: -credits,
  tokenValue: -credits,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createTenantCostMethods(mongoose);

  await mongoose.models.User.collection.insertMany([
    { _id: anna, tenantId: 'tenant-a', name: 'Anna', email: 'anna@a.example' },
    { _id: ben, tenantId: 'tenant-a', name: 'Ben', email: 'ben@a.example' },
    {
      _id: external,
      tenantId: 'tenant-a',
      name: 'Eve',
      email: 'eve@a.example',
      idOnTheSource: 'entra-eve',
    },
  ]);
  await mongoose.models.Group.collection.insertMany([
    {
      tenantId: 'tenant-a',
      name: 'Sales',
      source: 'local',
      memberIds: [anna.toString(), 'entra-eve'],
    },
    { tenantId: 'tenant-a', name: 'Empty', source: 'local', memberIds: [] },
    { tenantId: 'tenant-b', name: 'Other', source: 'local', memberIds: [anna.toString()] },
  ]);
  await mongoose.models.Transaction.collection.insertMany([
    tx('tenant-a', anna, prompt(1000, 2300), daysAgo(0)),
    tx('tenant-a', anna, completion(200, 1150), daysAgo(0)),
    tx('tenant-a', anna, search(2174), daysAgo(0)),
    tx('tenant-a', anna, fetch(1087), daysAgo(0)),
    tx('tenant-a', anna, fetch(1087), daysAgo(0)),
    tx('tenant-a', ben, completion(100, 500, 'mistral-small'), daysAgo(1)),
    tx('tenant-a', external, search(2174), daysAgo(1)),
    // A refill is no cost.
    tx(
      'tenant-a',
      anna,
      { tokenType: 'credits', context: 'autoRefill', rawAmount: 5000, tokenValue: 5000 },
      daysAgo(0),
    ),
    // Outside a 7-day window, inside October.
    tx('tenant-a', ben, completion(100, 700), daysAgo(15)),
    // September.
    tx('tenant-a', ben, completion(100, 900), daysAgo(25)),
    // Another tenant.
    tx('tenant-b', anna, prompt(1000, 9999), daysAgo(0)),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const costs = (
  tenantId: string,
  period: { days: 7 | 30 | 90 } | { month: string },
  byPerson = false,
) =>
  tenantStorage.run({ tenantId }, () =>
    methods.getTenantCosts({ tenantId, period, timeZone: 'Europe/Berlin', byPerson, now }),
  );

describe('getTenantCosts', () => {
  it('sums token, search and page fetch spend, not refills, in the window', async () => {
    const result = await costs('tenant-a', { days: 7 });

    expect(result.totals).toEqual({
      tokenCredits: 3950,
      searchCredits: 4348,
      searches: 2,
      fetchCredits: 2174,
      fetches: 2,
    });
    expect(result.models).toEqual([
      { model: 'mistral-large', tokenCredits: 3450, promptTokens: 1000, completionTokens: 200 },
      { model: 'mistral-small', tokenCredits: 500, promptTokens: 0, completionTokens: 100 },
    ]);
    expect(result.users).toBeUndefined();
    expect(result.groups).toBeUndefined();
  });

  it('returns every day of the period, with empty days filled in', async () => {
    const result = await costs('tenant-a', { days: 7 });

    expect(result.daily).toHaveLength(7);
    expect(result.from).toBe('2026-10-15');
    expect(result.to).toBe('2026-10-21');
    expect(result.daily[6]).toEqual({
      date: '2026-10-21',
      tokenCredits: 3450,
      searchCredits: 2174,
      searches: 1,
      fetchCredits: 2174,
      fetches: 2,
    });
    expect(result.daily[0]).toEqual({
      date: '2026-10-15',
      tokenCredits: 0,
      searchCredits: 0,
      searches: 0,
      fetchCredits: 0,
      fetches: 0,
    });
  });

  it('counts a calendar month up to today', async () => {
    const october = await costs('tenant-a', { month: '2026-10' });
    const september = await costs('tenant-a', { month: '2026-09' });

    expect(october.from).toBe('2026-10-01');
    expect(october.to).toBe('2026-10-21');
    expect(october.daily).toHaveLength(21);
    expect(october.totals.tokenCredits).toBe(4650);
    expect(september.daily).toHaveLength(30);
    expect(september.totals.tokenCredits).toBe(900);
  });

  it('lists users and groups by spend when asked', async () => {
    const result = await costs('tenant-a', { days: 7 }, true);

    expect(result.users).toEqual([
      {
        userId: anna.toString(),
        name: 'Anna',
        email: 'anna@a.example',
        tokenCredits: 3450,
        searchCredits: 2174,
        searches: 1,
        fetchCredits: 2174,
        fetches: 2,
      },
      {
        userId: external.toString(),
        name: 'Eve',
        email: 'eve@a.example',
        tokenCredits: 0,
        searchCredits: 2174,
        searches: 1,
        fetchCredits: 0,
        fetches: 0,
      },
      {
        userId: ben.toString(),
        name: 'Ben',
        email: 'ben@a.example',
        tokenCredits: 500,
        searchCredits: 0,
        searches: 0,
        fetchCredits: 0,
        fetches: 0,
      },
    ]);
    expect(result.groups).toEqual([
      expect.objectContaining({
        name: 'Sales',
        members: 2,
        tokenCredits: 3450,
        searchCredits: 4348,
        searches: 2,
        fetchCredits: 2174,
        fetches: 2,
      }),
      expect.objectContaining({ name: 'Empty', members: 0, tokenCredits: 0, searches: 0 }),
    ]);
  });

  it("never counts another tenant's spend", async () => {
    const result = await costs('tenant-b', { days: 7 }, true);

    expect(result.totals.tokenCredits).toBe(9999);
    expect(result.groups?.map((group) => group.name)).toEqual(['Other']);
  });
});

describe('isCostMonth', () => {
  it('accepts YYYY-MM only', () => {
    expect(isCostMonth('2026-10')).toBe(true);
    expect(isCostMonth('2026-13')).toBe(false);
    expect(isCostMonth('2026-1')).toBe(false);
    expect(isCostMonth('10-2026')).toBe(false);
  });
});
