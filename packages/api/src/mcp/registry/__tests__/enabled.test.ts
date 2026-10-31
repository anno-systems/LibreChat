import type * as t from '~/mcp/types';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { MCPServerInspector } from '~/mcp/registry/MCPServerInspector';

jest.mock('~/mcp/registry/MCPServerInspector');
jest.mock('~/mcp/registry/db/ServerConfigsDB', () => ({
  ServerConfigsDB: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(undefined),
    getAll: jest.fn().mockResolvedValue({}),
    add: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn().mockResolvedValue(undefined),
  })),
}));

const mockMongoose = {} as typeof import('mongoose');

const gmail: t.MCPOptions = { type: 'streamable-http', url: 'https://gmail.mcp.example.com/mcp' };
const drive: t.MCPOptions = { type: 'streamable-http', url: 'https://drive.mcp.example.com/mcp' };
const userServer = {
  type: 'streamable-http',
  url: 'https://user.example.com/mcp',
  source: 'user',
  dbId: 'db-1',
} as unknown as t.ParsedServerConfig;

interface DbRepoMock {
  get: jest.Mock;
  getAll: jest.Mock;
}

describe('MCPServersRegistry — per-scope enabled switch', () => {
  let registry: MCPServersRegistry;
  let inspectSpy: jest.SpyInstance;

  beforeEach(async () => {
    (MCPServersRegistry as unknown as { instance: undefined }).instance = undefined;
    MCPServersRegistry.createInstance(mockMongoose);
    registry = MCPServersRegistry.getInstance();
    inspectSpy = jest
      .spyOn(MCPServerInspector, 'inspect')
      .mockImplementation(
        async (_name: string, rawConfig: t.MCPOptions) =>
          ({ ...rawConfig, tools: 'a' }) as unknown as t.ParsedServerConfig,
      );
    await registry.reset();
    await registry.addServer('gmail', gmail, 'CACHE');
    await registry.addServer('drive', drive, 'CACHE');
    inspectSpy.mockClear();
  });

  /** The tenant's resolved `mcpConfig`: YAML base deep-merged with the tenant document. */
  const disabledTenantConfig = (): Record<string, t.MCPOptions> => ({
    gmail: { ...gmail, enabled: false },
    drive,
  });

  it('does not inspect a disabled server and marks it in the config servers', async () => {
    const configServers = await registry.ensureConfigServers(disabledTenantConfig());

    expect(inspectSpy).not.toHaveBeenCalled();
    expect(configServers.gmail).toEqual(expect.objectContaining({ enabled: false }));
    expect(configServers).not.toHaveProperty('drive');
  });

  it('leaves the disabled server out of the merged list and the single lookup', async () => {
    const configServers = await registry.ensureConfigServers(disabledTenantConfig());

    const all = await registry.getAllServerConfigs('user-1', configServers);
    expect(Object.keys(all).sort()).toEqual(['drive']);
    expect(await registry.getServerConfig('gmail', 'user-1', configServers)).toBeUndefined();
    expect(await registry.getServerConfig('drive', 'user-1', configServers)).toEqual(
      expect.objectContaining({ url: drive.url }),
    );
  });

  it('keeps the server for another tenant without an override', async () => {
    await registry.ensureConfigServers(disabledTenantConfig());
    const otherTenant = await registry.ensureConfigServers({ gmail, drive });

    const all = await registry.getAllServerConfigs('user-2', otherTenant);
    expect(Object.keys(all).sort()).toEqual(['drive', 'gmail']);
    expect(await registry.getServerConfig('gmail', 'user-2', otherTenant)).toEqual(
      expect.objectContaining({ url: gmail.url }),
    );
  });

  it('treats enabled: true like an absent field (no re-inspection, YAML entry used)', async () => {
    const configServers = await registry.ensureConfigServers({
      gmail: { ...gmail, enabled: true },
    });

    expect(inspectSpy).not.toHaveBeenCalled();
    expect(configServers).toEqual({});
    expect(await registry.getServerConfig('gmail', 'user-1', configServers)).toEqual(
      expect.objectContaining({ url: gmail.url, source: 'yaml' }),
    );
  });

  it('also switches off a server the tenant itself defines', async () => {
    const configServers = await registry.ensureConfigServers({
      tenant_only: { type: 'streamable-http', url: 'https://t.example.com/mcp', enabled: false },
    });

    expect(inspectSpy).not.toHaveBeenCalled();
    const all = await registry.getAllServerConfigs('user-1', configServers);
    expect(all).not.toHaveProperty('tenant_only');
    expect(await registry.getServerConfig('tenant_only', 'user-1', configServers)).toBeUndefined();
  });

  it('never removes a user-created server of the same name', async () => {
    const db = (registry as unknown as { dbConfigsRepo: DbRepoMock }).dbConfigsRepo;
    db.getAll.mockResolvedValue({ mine: userServer });
    db.get.mockImplementation(async (name: string) => (name === 'mine' ? userServer : undefined));

    const configServers = await registry.ensureConfigServers({
      mine: { type: 'streamable-http', url: 'https://x.example.com/mcp', enabled: false },
      gmail: { ...gmail, enabled: false },
    });

    const all = await registry.getAllServerConfigs('user-1', configServers);
    expect(Object.keys(all).sort()).toEqual(['drive', 'mine']);
    expect(all.mine).toEqual(userServer);
    expect(await registry.getServerConfig('mine', 'user-1', configServers)).toEqual(userServer);
  });

  it('changes nothing without configServers', async () => {
    const all = await registry.getAllServerConfigs('user-1');
    expect(Object.keys(all).sort()).toEqual(['drive', 'gmail']);
    expect(await registry.getServerConfig('gmail', 'user-1')).toEqual(
      expect.objectContaining({ url: gmail.url }),
    );
  });

  describe('opt-in: off in librechat.yaml, on per tenant', () => {
    const offByDefault: t.MCPOptions = { ...gmail, enabled: false };

    beforeEach(async () => {
      await registry.reset();
      await registry.addServer('gmail', offByDefault, 'CACHE');
      await registry.addServer('drive', drive, 'CACHE');
      inspectSpy.mockClear();
    });

    it('hides a server the YAML switches off for a tenant without an override', async () => {
      // The tenant's resolved mcpConfig is the YAML base unchanged.
      const configServers = await registry.ensureConfigServers({ gmail: offByDefault, drive });

      expect(inspectSpy).not.toHaveBeenCalled();
      const all = await registry.getAllServerConfigs('user-1', configServers);
      expect(Object.keys(all).sort()).toEqual(['drive']);
      expect(await registry.getServerConfig('gmail', 'user-1', configServers)).toBeUndefined();
    });

    it('shows it to a tenant whose document sets enabled: true', async () => {
      const configServers = await registry.ensureConfigServers({
        gmail: { ...offByDefault, enabled: true },
        drive,
      });

      expect(inspectSpy).not.toHaveBeenCalled();
      const all = await registry.getAllServerConfigs('user-1', configServers);
      expect(Object.keys(all).sort()).toEqual(['drive', 'gmail']);
      expect(all.gmail).not.toHaveProperty('enabled');
      expect(await registry.getServerConfig('gmail', 'user-1', configServers)).toEqual(
        expect.objectContaining({ url: gmail.url }),
      );
    });

    it('finds it again from its list entry, as tool discovery looks it up', async () => {
      const configServers = await registry.ensureConfigServers({
        gmail: { ...offByDefault, enabled: true },
      });
      const all = await registry.getAllServerConfigs('user-1', configServers);

      expect(await registry.getServerConfig('gmail', 'user-1', { gmail: all.gmail! })).toEqual(
        expect.objectContaining({ url: gmail.url }),
      );
    });

    it('is no MCP App target for a tenant that did not switch it on', async () => {
      const allowlists = { allowedDomains: null, allowedAddresses: null };
      const resolve = (gmailConfig: t.MCPOptions) =>
        registry.resolveCachedAppServerConfig({
          serverName: 'gmail',
          userId: 'user-1',
          mcpConfig: { gmail: gmailConfig, drive },
          ...allowlists,
        });

      await expect(resolve(offByDefault)).resolves.toBeUndefined();
      await expect(resolve({ ...offByDefault, enabled: true })).resolves.toEqual(
        expect.objectContaining({ serverConfig: expect.objectContaining({ url: gmail.url }) }),
      );
    });

    it('keeps tenants apart: one opted in, the other still sees nothing', async () => {
      const optedIn = await registry.ensureConfigServers({
        gmail: { ...offByDefault, enabled: true },
      });
      const other = await registry.ensureConfigServers({ gmail: offByDefault });

      expect(Object.keys(await registry.getAllServerConfigs('a', optedIn))).toContain('gmail');
      expect(Object.keys(await registry.getAllServerConfigs('b', other))).not.toContain('gmail');
    });
  });
  describe("billing gate: a priced server needs the tenant's subscription", () => {
    /** Stands in for the in-memory subscriptions: gmail is priced, tenant-a subscribed. */
    let subscribed: boolean;
    const unpaid = (name: string) => name === 'gmail' && !subscribed;

    beforeEach(() => {
      subscribed = false;
      registry.setBillingGate(unpaid);
    });

    afterEach(() => registry.setBillingGate(undefined));

    it('hides a priced server without a subscription, whatever the config documents say', async () => {
      // The YAML entry unchanged, and a group document that switches it on.
      for (const config of [
        { gmail, drive },
        { gmail: { ...gmail, enabled: true }, drive },
      ]) {
        const configServers = await registry.ensureConfigServers(config);
        expect(inspectSpy).not.toHaveBeenCalled();
        const all = await registry.getAllServerConfigs('user-1', configServers);
        expect(Object.keys(all).sort()).toEqual(['drive']);
        expect(await registry.getServerConfig('gmail', 'user-1', configServers)).toBeUndefined();
      }
    });

    it('shows it once subscribed, and a document can still switch it off', async () => {
      subscribed = true;
      const on = await registry.ensureConfigServers({ gmail, drive });
      expect(Object.keys(await registry.getAllServerConfigs('user-1', on)).sort()).toEqual([
        'drive',
        'gmail',
      ]);

      const narrowed = await registry.ensureConfigServers({ gmail: { ...gmail, enabled: false } });
      expect(await registry.getServerConfig('gmail', 'user-1', narrowed)).toBeUndefined();
    });

    it('leaves free servers and user-created servers alone', async () => {
      const db = (registry as unknown as { dbConfigsRepo: DbRepoMock }).dbConfigsRepo;
      db.getAll.mockResolvedValue({ gmail: userServer });
      db.get.mockImplementation(async (name: string) =>
        name === 'gmail' ? userServer : undefined,
      );
      await registry.reset();
      await registry.addServer('drive', drive, 'CACHE');

      const configServers = await registry.ensureConfigServers({ drive, gmail });
      const all = await registry.getAllServerConfigs('user-1', configServers);
      expect(Object.keys(all).sort()).toEqual(['drive', 'gmail']);
      expect(all.gmail).toEqual(userServer);
    });
  });
});
