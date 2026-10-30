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

interface StoredDoc {
  id?: string;
  provider?: string;
  model?: string;
  endpoint?: string;
  endpointType?: string;
  modelMigration?: { id: string; from: unknown; to: unknown };
  versions?: Array<{ model?: string }>;
  overrides?: { modelSpecs: { list: Array<{ preset: { model: string } }> } };
  configVersion?: number;
  favorites?: Array<{ endpoint?: string; model?: string }>;
}

const OLD = { endpoint: 'Mistral', model: 'mistral-large-2407' };
const NEW = { endpoint: 'Mistral', model: 'mistral-large-2411' };

async function seed(tenantId: string) {
  return inTenant(tenantId, async () => {
    const user = await mongoose.models.User.create({
      email: `ada@${tenantId}.test`,
      name: 'Ada',
      provider: 'openid',
      favorites: [{ endpoint: OLD.endpoint, model: OLD.model }, { agentId: 'agent_x' }],
    });
    const userId = user._id.toString();
    await mongoose.models.Agent.create({
      id: `agent_${tenantId}`,
      name: 'Helper',
      provider: OLD.endpoint,
      model: OLD.model,
      author: user._id,
      versions: [{ provider: OLD.endpoint, model: OLD.model }],
    });
    await mongoose.models.Agent.create({
      id: `agent_other_${tenantId}`,
      name: 'Other',
      provider: 'openAI',
      model: 'gpt-5',
      author: user._id,
    });
    await mongoose.models.Conversation.create([
      { conversationId: `direct-${tenantId}`, user: userId, ...OLD, endpointType: 'custom' },
      {
        conversationId: `agent-${tenantId}`,
        user: userId,
        endpoint: 'agents',
        agent_id: `agent_${tenantId}`,
      },
      { conversationId: `untouched-${tenantId}`, user: userId, endpoint: 'openAI', model: 'gpt-5' },
    ]);
    await mongoose.models.Preset.create({
      presetId: `preset-${tenantId}`,
      title: 'Large',
      user: userId,
      ...OLD,
    });
    await mongoose.models.Config.create({
      principalType: 'role',
      principalId: '__base__',
      principalModel: 'Role',
      priority: 0,
      overrides: {
        modelSpecs: {
          list: [
            { name: 'large', label: 'Large', preset: { ...OLD, endpointType: 'custom' } },
            { name: 'gpt', label: 'GPT', preset: { endpoint: 'openAI', model: 'gpt-5' } },
          ],
        },
      },
    });
    return userId;
  });
}

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
    for (const name of ['User', 'Agent', 'Conversation', 'Preset', 'Config', 'ModelRedirect']) {
      await mongoose.models[name].deleteMany({});
    }
  });
});

const read = <T>(tenantId: string, name: string, filter: Record<string, unknown>, select = '') =>
  inTenant(
    tenantId,
    async () => (await mongoose.models[name].findOne(filter).select(select).lean()) as T,
  );

describe('migrateModelUsage', () => {
  it('rewrites every kind within the tenant and leaves other tenants alone', async () => {
    await seed('acme');
    await seed('globex');

    const result = await methods.migrateModelUsage({
      migrationId: 'mm_1',
      from: OLD,
      to: NEW,
      agentProviders: ['Mistral'],
      audience: { tenantId: 'acme' },
    });

    expect(result.counts).toEqual({
      agents: 1,
      conversations: 1,
      agentConversations: 1,
      presets: 1,
      modelSpecs: 1,
      favorites: 1,
    });
    expect(result.configTenants).toEqual(['acme']);
    expect(result.userIds).toHaveLength(1);
    expect(Object.keys(result.byTenant)).toEqual(['acme']);

    const agent = await read<StoredDoc>('acme', 'Agent', { id: 'agent_acme' });
    expect(agent).toMatchObject({ provider: 'Mistral', model: NEW.model });
    expect(agent.modelMigration).toMatchObject({ id: 'mm_1', from: OLD, to: NEW });
    expect(agent.versions?.[0]).toMatchObject({ model: OLD.model });

    const direct = await read<StoredDoc>(
      'acme',
      'Conversation',
      { conversationId: 'direct-acme' },
      '+modelMigration',
    );
    expect(direct).toMatchObject({ endpoint: 'Mistral', model: NEW.model, endpointType: 'custom' });
    expect(direct.modelMigration?.id).toBe('mm_1');
    const agentConvo = await read<StoredDoc>(
      'acme',
      'Conversation',
      { conversationId: 'agent-acme' },
      '+modelMigration',
    );
    expect(agentConvo.modelMigration?.to).toEqual(NEW);
    const preset = await read<StoredDoc>('acme', 'Preset', { presetId: 'preset-acme' });
    expect(preset.model).toBe(NEW.model);
    const config = await read<StoredDoc>('acme', 'Config', {});
    expect(config.overrides?.modelSpecs.list[0].preset.model).toBe(NEW.model);
    expect(config.overrides?.modelSpecs.list[1].preset.model).toBe('gpt-5');
    expect(config.configVersion).toBe(1);
    const user = await read<StoredDoc>('acme', 'User', {});
    expect(user.favorites?.[0]).toMatchObject(NEW);

    const other = await read<StoredDoc>('globex', 'Agent', { id: 'agent_globex' });
    expect(other.model).toBe(OLD.model);
    expect(other.modelMigration).toBeUndefined();
    const otherConvo = await read<StoredDoc>('globex', 'Conversation', {
      conversationId: 'direct-globex',
    });
    expect(otherConvo.model).toBe(OLD.model);
    const otherConfig = await read<StoredDoc>('globex', 'Config', {});
    expect(otherConfig.overrides?.modelSpecs.list[0].preset.model).toBe(OLD.model);
  });

  it('changes nothing when run again', async () => {
    await seed('acme');
    const input = {
      migrationId: 'mm_1',
      from: OLD,
      to: NEW,
      agentProviders: ['Mistral'],
      audience: { tenantId: 'acme' },
    };
    await methods.migrateModelUsage(input);
    const again = await methods.migrateModelUsage(input);
    expect(Object.values(again.counts).every((n) => n === 0)).toBe(true);
    const config = await read<StoredDoc>('acme', 'Config', {});
    expect(config.configVersion).toBe(1);
  });

  it('reaches listed tenants or every tenant on a platform migration, in small batches', async () => {
    await seed('acme');
    await seed('globex');
    await seed('initech');
    const listed = await methods.migrateModelUsage({
      migrationId: 'mm_2',
      from: OLD,
      to: { endpoint: 'Azure', model: 'gpt-5' },
      agentProviders: ['Mistral'],
      audience: { tenantIds: ['acme', 'globex'] },
      batchSize: 1,
    });
    expect(listed.counts.agents).toBe(2);
    expect(listed.byTenant.acme.conversations).toBe(1);
    expect(listed.byTenant.globex.conversations).toBe(1);
    const moved = await read<StoredDoc>('acme', 'Conversation', {
      conversationId: 'direct-acme',
    });
    expect(moved).toMatchObject({ endpoint: 'Azure', model: 'gpt-5' });
    expect(moved.endpointType).toBeUndefined();
    const untouched = await read<StoredDoc>('initech', 'Agent', { id: 'agent_initech' });
    expect(untouched.model).toBe(OLD.model);

    const all = await methods.migrateModelUsage({
      migrationId: 'mm_3',
      from: OLD,
      to: NEW,
      agentProviders: ['Mistral'],
      audience: { all: true },
    });
    expect(all.counts.agents).toBe(1);
    expect(Object.keys(all.byTenant)).toEqual(['initech']);
  });

  it('leaves platform agent copies to their definition', async () => {
    await inTenant('acme', async () => {
      await mongoose.models.Agent.collection.insertOne({
        id: 'agent_pa_support',
        tenantId: 'acme',
        provider: OLD.endpoint,
        model: OLD.model,
        platformAgentId: 'support',
      });
    });
    const result = await methods.migrateModelUsage({
      migrationId: 'mm_1',
      from: OLD,
      to: NEW,
      agentProviders: ['Mistral'],
      audience: { tenantId: 'acme' },
    });
    expect(result.counts.agents).toBe(0);
  });
});

describe('previews and usage', () => {
  it('counts per kind without changing anything', async () => {
    await seed('acme');
    await seed('globex');
    const preview = await methods.previewModelMigration(OLD, ['Mistral'], { tenantId: 'acme' });
    expect(preview).toEqual({
      agents: 1,
      conversations: 1,
      agentConversations: 1,
      presets: 1,
      modelSpecs: 1,
      favorites: 1,
    });
    const usage = await methods.countModelUsage(
      [
        { ...OLD, agentProviders: ['Mistral'] },
        { endpoint: 'openAI', model: 'gpt-5', agentProviders: ['openAI'] },
      ],
      { all: true },
    );
    expect(usage).toEqual([
      { ...OLD, agents: 2, conversations: 2 },
      { endpoint: 'openAI', model: 'gpt-5', agents: 2, conversations: 2 },
    ]);
    const agent = await read<StoredDoc>('acme', 'Agent', { id: 'agent_acme' });
    expect(agent.model).toBe(OLD.model);
  });
});

describe('redirects', () => {
  it('upserts one redirect per scope, audience and old model, and keeps the copy current', async () => {
    const first = await methods.upsertModelRedirect({ scope: 'platform', from: OLD, to: NEW });
    const second = await methods.upsertModelRedirect({
      scope: 'platform',
      from: OLD,
      to: { endpoint: 'Mistral', model: 'other' },
    });
    expect(second.redirectId).toBe(first.redirectId);
    const listed = await methods.upsertModelRedirect({
      scope: 'platform',
      tenantIds: ['b', 'a', 'a'],
      from: OLD,
      to: NEW,
    });
    expect(listed.redirectId).not.toBe(first.redirectId);
    expect(listed.tenantIds).toEqual(['a', 'b']);
    const own = await methods.upsertModelRedirect({ scope: 'acme', from: OLD, to: NEW });
    expect(methods.getModelRedirects()).toHaveLength(3);

    await methods.recordModelMigrationRun(own.redirectId, {
      agents: 1,
      conversations: 0,
      agentConversations: 0,
      presets: 0,
      modelSpecs: 0,
      favorites: 0,
    });
    const reloaded = createModelMigrationMethods(mongoose);
    await reloaded.loadModelRedirects();
    expect(
      reloaded.getModelRedirects().find((r) => r.scope === 'acme')?.lastRun?.counts.agents,
    ).toBe(1);

    expect(await methods.deleteModelRedirect('globex', own.redirectId)).toBe(false);
    expect(await methods.deleteModelRedirect('acme', own.redirectId)).toBe(true);
    expect(methods.getModelRedirects()).toHaveLength(2);
  });
});

describe('notices', () => {
  it('reads and clears a conversation notice for its owner only, and an agent notice', async () => {
    const userId = await seed('acme');
    await methods.migrateModelUsage({
      migrationId: 'mm_1',
      from: OLD,
      to: NEW,
      agentProviders: ['Mistral'],
      audience: { tenantId: 'acme' },
    });
    await inTenant('acme', async () => {
      expect(await methods.getConversationModelMigration('someone', 'direct-acme')).toBeNull();
      const notice = await methods.getConversationModelMigration(userId, 'direct-acme');
      expect(notice).toMatchObject({ from: OLD, to: NEW });
      expect(await methods.clearConversationModelMigration(userId, 'direct-acme')).toBe(true);
      expect(await methods.clearConversationModelMigration(userId, 'direct-acme')).toBe(false);
      expect(await methods.getConversationModelMigration(userId, 'direct-acme')).toBeNull();
      expect(await methods.clearAgentModelMigration('agent_acme')).toBe(true);
      expect(await methods.clearAgentModelMigration('agent_acme')).toBe(false);
    });
  });
});
