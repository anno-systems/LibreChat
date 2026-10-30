import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { tenantStorage, runAsSystem } from '../config/tenantContext';
import { createModelMigrationMethods } from './modelMigration';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createModelMigrationMethods>;
const previousStrict = process.env.TENANT_ISOLATION_STRICT;

const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);

async function seed(tenantId: string) {
  await inTenant(tenantId, async () => {
    const user = await mongoose.models.User.create({
      email: `ada@${tenantId}.test`,
      name: 'Ada',
      provider: 'openid',
    });
    const userId = user._id.toString();
    await mongoose.models.Agent.create([
      { id: `a1_${tenantId}`, name: 'A', provider: 'Mistral', model: 'large', author: user._id },
      { id: `a2_${tenantId}`, name: 'B', provider: 'Mistral', model: 'large', author: user._id },
    ]);
    /* A platform agent's copy, which only the operator writes (raw insert past the lock). */
    await mongoose.models.Agent.collection.insertOne({
      id: `pa_${tenantId}`,
      tenantId,
      name: 'Platform',
      provider: 'Mistral',
      model: 'old',
      author: user._id,
      platformAgentId: 'helper',
    });
    await mongoose.models.Conversation.create([
      { conversationId: `c1-${tenantId}`, user: userId, endpoint: 'Mistral', model: 'large' },
      { conversationId: `c2-${tenantId}`, user: userId, endpoint: 'Mistral', model: 'large' },
      {
        conversationId: `c3-${tenantId}`,
        user: userId,
        endpoint: 'Mistral',
        model: 'large',
        isArchived: true,
      },
      { conversationId: `c4-${tenantId}`, user: userId, endpoint: 'openAI', model: tenantId },
      { conversationId: `c5-${tenantId}`, user: userId, endpoint: 'agents', model: 'large' },
      { conversationId: `c6-${tenantId}`, user: userId, endpoint: 'openAI' },
    ]);
  });
}

beforeAll(async () => {
  process.env.TENANT_ISOLATION_STRICT = 'true';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createModelMigrationMethods(mongoose);
  await seed('acme');
  await seed('globex');
});

afterAll(async () => {
  await runAsSystem(async () => {
    for (const name of ['User', 'Agent', 'Conversation']) {
      await mongoose.models[name].deleteMany({});
    }
  });
  await mongoose.disconnect();
  await mongoServer.stop();
  process.env.TENANT_ISOLATION_STRICT = previousStrict;
});

const sorted = <T extends { tenantId: string; endpoint: string; model: string }>(rows: T[]) =>
  [...rows].sort((a, b) =>
    `${a.tenantId}/${a.endpoint}/${a.model}`.localeCompare(
      `${b.tenantId}/${b.endpoint}/${b.model}`,
    ),
  );

describe('listUsedModels', () => {
  it("counts one tenant's agents and active conversations per model", async () => {
    const used = await methods.listUsedModels(
      { tenantId: 'acme' },
      { exceptConversationEndpoints: ['agents'] },
    );
    expect(sorted(used)).toEqual([
      { tenantId: 'acme', endpoint: 'Mistral', model: 'large', agents: 2, conversations: 2 },
      { tenantId: 'acme', endpoint: 'openAI', model: 'acme', agents: 0, conversations: 1 },
    ]);
  });

  it('covers every tenant for the operator, without leaking across a tenant scope', async () => {
    const all = await methods.listUsedModels(
      { all: true },
      { exceptConversationEndpoints: ['agents'] },
    );
    expect(sorted(all).map((u) => `${u.tenantId}/${u.endpoint}/${u.model}`)).toEqual([
      'acme/Mistral/large',
      'acme/openAI/acme',
      'globex/Mistral/large',
      'globex/openAI/globex',
    ]);
    const listed = await methods.listUsedModels({ tenantIds: ['globex'] });
    expect(listed.every((u) => u.tenantId === 'globex')).toBe(true);
    expect(listed.find((u) => u.endpoint === 'agents')).toEqual(
      expect.objectContaining({ model: 'large', conversations: 1 }),
    );
  });
});
