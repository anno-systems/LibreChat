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

const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);

const OLD = { endpoint: 'Mistral', model: 'mistral-large-2407' };
const NEW = { endpoint: 'Mistral', model: 'mistral-large-2411' };

interface Seeded {
  member: string;
  outsider: string;
  groupId: string;
}

/** A tenant with a group member (by `idOnTheSource`) and an outsider, each owning every kind. */
async function seed(tenantId: string): Promise<Seeded> {
  return inTenant(tenantId, async () => {
    const [member, outsider] = await mongoose.models.User.create([
      {
        email: `member@${tenantId}.test`,
        provider: 'openid',
        idOnTheSource: `ext-member-${tenantId}`,
        favorites: [{ ...OLD }],
      },
      { email: `outsider@${tenantId}.test`, provider: 'openid', favorites: [{ ...OLD }] },
    ]);
    const group = await mongoose.models.Group.create({
      name: 'Research',
      source: 'local',
      memberIds: [`ext-member-${tenantId}`],
    });
    for (const [key, user] of [
      ['member', member],
      ['outsider', outsider],
    ] as const) {
      const userId = user._id.toString();
      await mongoose.models.Agent.create({
        id: `agent_${key}_${tenantId}`,
        name: key,
        provider: OLD.endpoint,
        model: OLD.model,
        author: user._id,
      });
      await mongoose.models.Conversation.create({
        conversationId: `c-${key}-${tenantId}`,
        user: userId,
        ...OLD,
      });
      await mongoose.models.Preset.create({
        presetId: `p-${key}-${tenantId}`,
        title: key,
        user: userId,
        ...OLD,
      });
    }
    await mongoose.models.Config.create({
      principalType: 'role',
      principalId: '__base__',
      principalModel: 'Role',
      priority: 0,
      overrides: { modelSpecs: { list: [{ name: 'large', label: 'Large', preset: { ...OLD } }] } },
    });
    return {
      member: member._id.toString(),
      outsider: outsider._id.toString(),
      groupId: group._id.toString(),
    };
  });
}

const modelOf = (tenantId: string, name: string, filter: Record<string, unknown>) =>
  inTenant(tenantId, async () => {
    const doc = await mongoose.models[name].findOne(filter).lean<{ model?: string }>();
    return doc?.model;
  });

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createModelMigrationMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await runAsSystem(async () => {
    for (const name of ['User', 'Group', 'Agent', 'Conversation', 'Preset', 'Config']) {
      await mongoose.models[name].deleteMany({});
    }
  });
});

describe('findGroupMemberUsers', () => {
  it('resolves members by idOnTheSource, else by user id', async () => {
    const acme = await seed('acme');
    const raw = await inTenant('acme', async () => {
      const user = await mongoose.models.User.create({ email: 'raw@acme.test', provider: 'local' });
      await mongoose.models.Group.updateOne(
        { _id: acme.groupId },
        { $push: { memberIds: user._id.toString() } },
      );
      return user._id.toString();
    });

    const result = await methods.findGroupMemberUsers('acme', [acme.groupId]);
    expect(result.ok && [...result.userIds].sort()).toEqual([acme.member, raw].sort());
  });

  it('fails as unknown_group for ids of no group, malformed ids and other tenants’ groups', async () => {
    const acme = await seed('acme');
    const globex = await seed('globex');
    const missing = new mongoose.Types.ObjectId().toString();

    const result = await methods.findGroupMemberUsers('acme', [
      acme.groupId,
      globex.groupId,
      missing,
      'not-an-id',
    ]);
    expect(result).toEqual({
      ok: false,
      error: { code: 'unknown_group', groupIds: [globex.groupId, missing, 'not-an-id'] },
    });
  });

  it('does not count a member with the same external id in another tenant', async () => {
    const acme = await seed('acme');
    await inTenant('globex', () =>
      mongoose.models.User.create({
        email: 'twin@globex.test',
        provider: 'openid',
        idOnTheSource: 'ext-member-acme',
      }),
    );

    const result = await methods.findGroupMemberUsers('acme', [acme.groupId]);
    expect(result).toEqual({ ok: true, userIds: [acme.member] });
  });
});

describe('scoped migrations (exceptUsers)', () => {
  it('rewrites only what non-members own and leaves config documents alone', async () => {
    const acme = await seed('acme');
    await seed('globex');

    const result = await methods.migrateModelUsage({
      migrationId: 'mm_scoped',
      from: OLD,
      to: NEW,
      agentProviders: ['Mistral'],
      audience: { tenantId: 'acme', exceptUsers: [acme.member] },
      batchSize: 1,
    });

    expect(result.counts).toEqual({
      agents: 1,
      conversations: 1,
      agentConversations: 0,
      presets: 1,
      modelSpecs: 0,
      favorites: 1,
    });
    expect(result.configTenants).toEqual([]);
    expect(result.userIds).toEqual([acme.outsider]);

    expect(await modelOf('acme', 'Agent', { id: 'agent_outsider_acme' })).toBe(NEW.model);
    expect(await modelOf('acme', 'Agent', { id: 'agent_member_acme' })).toBe(OLD.model);
    expect(await modelOf('acme', 'Conversation', { conversationId: 'c-outsider-acme' })).toBe(
      NEW.model,
    );
    expect(await modelOf('acme', 'Conversation', { conversationId: 'c-member-acme' })).toBe(
      OLD.model,
    );
    expect(await modelOf('acme', 'Preset', { presetId: 'p-outsider-acme' })).toBe(NEW.model);
    expect(await modelOf('acme', 'Preset', { presetId: 'p-member-acme' })).toBe(OLD.model);

    const favorites = await inTenant('acme', async () => {
      const users = await mongoose.models.User.find({})
        .select('favorites')
        .lean<Array<{ _id: unknown; favorites: Array<{ model: string }> }>>();
      return Object.fromEntries(users.map((u) => [String(u._id), u.favorites[0].model]));
    });
    expect(favorites).toEqual({ [acme.member]: OLD.model, [acme.outsider]: NEW.model });

    const config = await inTenant('acme', () =>
      mongoose.models.Config.findOne({}).lean<{
        configVersion?: number;
        overrides: { modelSpecs: { list: Array<{ preset: { model: string } }> } };
      }>(),
    );
    expect(config?.overrides.modelSpecs.list[0].preset.model).toBe(OLD.model);
    expect(config?.configVersion ?? 0).toBe(0);

    expect(await modelOf('globex', 'Agent', { id: 'agent_outsider_globex' })).toBe(OLD.model);
    expect(await modelOf('globex', 'Conversation', { conversationId: 'c-outsider-globex' })).toBe(
      OLD.model,
    );
  });

  it('previews and counts usage with the same filter', async () => {
    const acme = await seed('acme');
    const audience = { tenantId: 'acme', exceptUsers: [acme.member] };

    expect(await methods.previewModelMigration(OLD, ['Mistral'], audience)).toEqual({
      agents: 1,
      conversations: 1,
      agentConversations: 0,
      presets: 1,
      modelSpecs: 0,
      favorites: 1,
    });
    expect(
      await methods.countModelUsage([{ ...OLD, agentProviders: ['Mistral'] }], audience),
    ).toEqual([{ ...OLD, agents: 1, conversations: 1 }]);
    /* Without exceptions, both users and the model spec count. */
    expect(await methods.previewModelMigration(OLD, ['Mistral'], { tenantId: 'acme' })).toEqual({
      agents: 2,
      conversations: 2,
      agentConversations: 0,
      presets: 2,
      modelSpecs: 1,
      favorites: 2,
    });
  });
});
