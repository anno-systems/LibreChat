import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { AccessRoleIds, PrincipalType, ResourceType } from 'librechat-data-provider';
import type { PlatformAgentInput } from './platformAgent';
import type { IAclEntry, IAgent } from '~/types';
import { PlatformAgentLockedError } from '~/models/plugins/platformAgentLock';
import { PLATFORM_AGENT_AUTHOR, platformAgentCopyId } from './platformAgent';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createModels } from '~/models';
import { createMethods } from './index';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

const support: PlatformAgentInput = {
  platformAgentId: 'platform_support',
  name: 'Support',
  description: 'Answers questions about the platform',
  instructions: 'Be helpful.',
  conversation_starters: ['Is there an outage?'],
  tools: ['platform_status_mcp_support', 'sys__server__sys_mcp_support'],
  provider: 'Mistral Platform',
  model: 'mistral-small',
  tenants: 'all',
};

const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);
const Agent = () => mongoose.models.Agent as mongoose.Model<IAgent>;
const AclEntry = () => mongoose.models.AclEntry as mongoose.Model<IAclEntry>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.db?.dropDatabase();
  await runAsSystem(async () => await methods.seedDefaultRoles());
});

describe('platform agent definitions', () => {
  it('creates, replaces and deletes a definition, keeping the tenants that switched it off', async () => {
    await methods.upsertPlatformAgent(support);
    expect(await methods.setPlatformAgentEnabled('platform_support', 'acme', false)).toMatchObject({
      disabledTenants: ['acme'],
    });

    const replaced = await methods.upsertPlatformAgent({
      ...support,
      name: 'Help',
      tenants: ['acme', 'beta', 'acme'],
      model_parameters: { temperature: 0.2 },
    });

    expect(replaced).toMatchObject({
      name: 'Help',
      tenants: ['acme', 'beta'],
      disabledTenants: ['acme'],
      model_parameters: { temperature: 0.2 },
    });
    expect(replaced.updatedAt).toBeInstanceOf(Date);

    const cleared = await methods.upsertPlatformAgent({ ...support, model_parameters: undefined });
    expect(cleared.model_parameters).toBeUndefined();
    expect(cleared.tenants).toBe('all');

    expect(
      (await methods.setPlatformAgentEnabled('platform_support', 'acme', true))?.disabledTenants,
    ).toEqual([]);
    expect(await methods.listPlatformAgents()).toHaveLength(1);
    expect(await methods.platformAgentsUsingProvider('Mistral Platform')).toEqual([
      'platform_support',
    ]);
    expect(await methods.platformAgentsUsingProvider('Other')).toEqual([]);
    expect(await methods.deletePlatformAgent('platform_support')).toBe(true);
    expect(await methods.deletePlatformAgent('platform_support')).toBe(false);
    expect(await methods.getPlatformAgent('platform_support')).toBeNull();
    expect(await methods.setPlatformAgentEnabled('platform_support', 'acme', false)).toBeNull();
  });
});

describe('tenant copies', () => {
  it('writes a copy shared with everyone in the tenant and updates it in place', async () => {
    const agent = await methods.upsertPlatformAgent(support);
    await methods.writePlatformAgentCopy('acme', agent);
    await methods.writePlatformAgentCopy('acme', { ...agent, name: 'Support 2' });

    const copies = await inTenant('acme', async () =>
      Agent()
        .find({ id: platformAgentCopyId('platform_support') })
        .lean(),
    );
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({
      id: 'agent_platform_support',
      name: 'Support 2',
      tenantId: 'acme',
      platformAgentId: 'platform_support',
      provider: 'Mistral Platform',
      model: 'mistral-small',
      mcpServerNames: ['support'],
      category: 'general',
    });
    expect(String(copies[0].author)).toBe(String(PLATFORM_AGENT_AUTHOR));
    expect(copies[0].versions).toHaveLength(1);

    const grants = await inTenant('acme', async () =>
      AclEntry().find({ resourceId: copies[0]._id }).lean(),
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      principalType: PrincipalType.PUBLIC,
      resourceType: ResourceType.AGENT,
      tenantId: 'acme',
    });
    const viewer = await methods.findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER);
    expect(grants[0].permBits).toBe(viewer?.permBits);
  });

  it('lists copies per tenant and per agent, and removes one with its grants', async () => {
    const agent = await methods.upsertPlatformAgent(support);
    await methods.writePlatformAgentCopy('acme', agent);
    await methods.writePlatformAgentCopy('beta', agent);

    expect(
      (await methods.listPlatformAgentCopies('platform_support')).map((c) => c.tenantId).sort(),
    ).toEqual(['acme', 'beta']);
    expect(await methods.listTenantPlatformAgentCopies('beta')).toEqual([
      expect.objectContaining({
        tenantId: 'beta',
        platformAgentId: 'platform_support',
        agentId: 'agent_platform_support',
      }),
    ]);

    expect(await methods.removePlatformAgentCopy('acme', 'platform_support')).toBe(true);
    expect(await methods.removePlatformAgentCopy('acme', 'platform_support')).toBe(false);
    expect(await methods.listTenantPlatformAgentCopies('acme')).toEqual([]);
    const grants = await runAsSystem(async () => AclEntry().find({}).lean());
    expect(grants.map((g) => g.tenantId)).toEqual(['beta']);
  });
});

describe('platform agent lock', () => {
  it('keeps upstream agent writes off a copy and leaves other agents alone', async () => {
    const agent = await methods.upsertPlatformAgent(support);
    await methods.writePlatformAgentCopy('acme', agent);
    const own = await inTenant('acme', async () =>
      methods.createAgent({
        id: 'agent_own',
        name: 'Own',
        provider: 'openAI',
        model: 'gpt-4o',
        author: new mongoose.Types.ObjectId(),
      }),
    );

    await inTenant('acme', async () => {
      expect(
        await methods.updateAgent({ id: 'agent_platform_support' }, { name: 'Hijacked' }),
      ).toBeNull();
      expect(await methods.deleteAgent({ id: 'agent_platform_support' })).toBeNull();
      await Agent().updateMany({}, { $set: { description: 'changed' } });
      expect(await methods.updateAgent({ id: own.id }, { name: 'Renamed' })).toMatchObject({
        name: 'Renamed',
      });
    });

    const copy = await inTenant('acme', async () =>
      Agent().findOne({ id: 'agent_platform_support' }).lean(),
    );
    expect(copy).toMatchObject({ name: 'Support', description: support.description });
  });

  it('refuses to create or duplicate a document that claims to be a copy', async () => {
    await inTenant('acme', async () => {
      await expect(
        methods.createAgent({
          id: 'agent_fake',
          name: 'Fake',
          provider: 'Mistral Platform',
          model: 'mistral-small',
          author: new mongoose.Types.ObjectId(),
          platformAgentId: 'platform_support',
        }),
      ).rejects.toBeInstanceOf(PlatformAgentLockedError);
    });
    expect(await runAsSystem(async () => Agent().countDocuments({}))).toBe(0);
  });

  it('lets a tenant purge delete copies with the rest of the tenant', async () => {
    await methods.writePlatformAgentCopy('acme', await methods.upsertPlatformAgent(support));
    await inTenant('acme', async () => Agent().deleteMany({ tenantId: 'acme' }));
    expect(await methods.listTenantPlatformAgentCopies('acme')).toEqual([]);
  });
});
