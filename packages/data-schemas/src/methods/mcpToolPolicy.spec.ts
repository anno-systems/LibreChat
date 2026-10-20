import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMcpToolPolicyMethods } from './mcpToolPolicy';
import { tenantStorage } from '../config/tenantContext';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMcpToolPolicyMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  methods = createMcpToolPolicyMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.PlatformMcpTool.deleteMany({});
  await tenantStorage.run(
    { tenantId: '__SYSTEM__' },
    async () => await mongoose.models.McpToolPolicy.deleteMany({}),
  );
});

describe('registered tools', () => {
  it('replaces a server tools and keeps other servers', async () => {
    await methods.setPlatformMcpTools('mail', [
      { name: 'search', readOnly: true },
      { name: 'send', readOnly: false, title: 'Send mail' },
    ]);
    await methods.setPlatformMcpTools('files', [{ name: 'list', readOnly: true }]);
    await methods.setPlatformMcpTools('mail', [{ name: 'send', readOnly: false }]);

    expect(await methods.listPlatformMcpTools('mail')).toEqual([
      { server: 'mail', name: 'send', readOnly: false },
    ]);
    expect(await methods.listPlatformMcpTools()).toHaveLength(2);
  });
});

describe('tool policy rules', () => {
  const tenantRule = {
    server: 'mail',
    tool: 'send',
    principalType: 'tenant' as const,
    principalId: 'ignored',
    mode: 'off' as const,
  };
  const groupRule = {
    ...tenantRule,
    principalType: 'group' as const,
    principalId: 'g1',
    mode: 'allow' as const,
  };

  it('keeps rules per tenant and finds the tenant rule and the given groups', async () => {
    await methods.setMcpToolPolicy('tenant-a', tenantRule);
    await methods.setMcpToolPolicy('tenant-a', groupRule);
    await methods.setMcpToolPolicy('tenant-a', {
      ...groupRule,
      principalId: 'g2',
      mode: 'confirm',
    });
    await methods.setMcpToolPolicy('tenant-b', { ...tenantRule, mode: 'allow' });

    const found = await methods.findMcpToolPolicies('tenant-a', 'mail', ['g1']);
    expect(found).toHaveLength(2);
    expect(found).toEqual(expect.arrayContaining([{ ...tenantRule, principalId: '' }, groupRule]));
    expect(await methods.listMcpToolPolicies('tenant-b')).toEqual([
      { ...tenantRule, principalId: '', mode: 'allow' },
    ]);
  });

  it('updates a rule in place and deletes rules', async () => {
    await methods.setMcpToolPolicy('tenant-a', groupRule);
    await methods.setMcpToolPolicy('tenant-a', { ...groupRule, mode: 'off' });
    expect(await methods.listMcpToolPolicies('tenant-a')).toEqual([{ ...groupRule, mode: 'off' }]);

    expect(await methods.deleteMcpToolPolicy('tenant-b', groupRule)).toBe(false);
    expect(await methods.deleteMcpToolPolicy('tenant-a', groupRule)).toBe(true);
  });
});
