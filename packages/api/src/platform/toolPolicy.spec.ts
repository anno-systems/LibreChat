import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMcpToolPolicyMethods, tenantStorage } from '@librechat/data-schemas';
import type { McpToolPolicyRule, PlatformMcpTool } from '@librechat/data-schemas';
import type { PreToolUseHookInput } from '@librechat/agents';
import type { Request, Response } from 'express';
import type { ServerRequest } from '~/types/http';
import {
  createToolPolicyHandlers,
  createToolPolicyHookFactory,
  createToolPolicyResolver,
  groupIdsFromPrincipals,
  parseMcpToolName,
  resolveToolMode,
} from './toolPolicy';

const send: PlatformMcpTool = { server: 'mail', name: 'send', readOnly: false };
const search: PlatformMcpTool = { server: 'mail', name: 'search', readOnly: true };

function rule(
  principalType: 'tenant' | 'group',
  principalId: string,
  mode: McpToolPolicyRule['mode'],
  tool = 'send',
): McpToolPolicyRule {
  return { server: 'mail', tool, principalType, principalId, mode };
}

describe('resolveToolMode', () => {
  it('defaults to allow for read-only tools and confirm for the others', () => {
    expect(resolveToolMode(search, [], new Set())).toBe('allow');
    expect(resolveToolMode(send, [], new Set())).toBe('confirm');
  });

  it('takes the tenant rule unless a group of the user has one', () => {
    const rules = [rule('tenant', '', 'off'), rule('group', 'g1', 'confirm')];
    expect(resolveToolMode(send, rules, new Set())).toBe('off');
    expect(resolveToolMode(send, rules, new Set(['g2']))).toBe('off');
    expect(resolveToolMode(send, rules, new Set(['g1']))).toBe('confirm');
  });

  it('takes the most permissive group rule and ignores other tools', () => {
    const rules = [
      rule('group', 'g1', 'off'),
      rule('group', 'g2', 'allow'),
      rule('group', 'g3', 'confirm'),
      rule('group', 'g1', 'allow', 'search'),
    ];
    expect(resolveToolMode(send, rules, new Set(['g1', 'g3']))).toBe('confirm');
    expect(resolveToolMode(send, rules, new Set(['g1', 'g2', 'g3']))).toBe('allow');
    expect(resolveToolMode(send, rules, new Set(['g1']))).toBe('off');
  });
});

describe('parseMcpToolName', () => {
  it('splits the tool and server at the last delimiter', () => {
    expect(parseMcpToolName('send_mcp_outlook-mail')).toEqual({
      tool: 'send',
      server: 'outlook-mail',
    });
    expect(parseMcpToolName('a_mcp_b_mcp_c')).toEqual({ tool: 'a_mcp_b', server: 'c' });
    expect(parseMcpToolName('web_search')).toBeNull();
    expect(parseMcpToolName('send_mcp_')).toBeNull();
  });
});

describe('groupIdsFromPrincipals', () => {
  it('keeps group principals only', () => {
    expect(
      groupIdsFromPrincipals([
        { principalType: 'user', principalId: 'u1' },
        { principalType: 'group', principalId: 'g1' },
        { principalType: 'role', principalId: 'USER' },
      ]),
    ).toEqual(['g1']);
  });
});

describe('tool policy hook', () => {
  const call = (toolName: string) =>
    ({
      hook_event_name: 'PreToolUse',
      toolName,
      toolInput: {},
      toolUseId: 't',
      runId: 'r',
    }) as PreToolUseHookInput;
  const signal = new AbortController().signal;

  function hookWith(modesFor: jest.Mock) {
    const factory = createToolPolicyHookFactory({ modesFor });
    return factory({ userId: 'u1', tenantId: 'tenant-a' })!;
  }

  it('opts out without a user or tenant', () => {
    const factory = createToolPolicyHookFactory({ modesFor: jest.fn() });
    expect(factory({ userId: 'u1' })).toBeUndefined();
    expect(factory({ tenantId: 't' })).toBeUndefined();
  });

  it('denies off tools, asks for confirm tools, abstains for allowed and foreign tools', async () => {
    const modesFor = jest.fn(async ({ server }: { server: string }) =>
      server === 'mail' ? { send: 'confirm', delete: 'off', search: 'allow' } : null,
    );
    const hook = hookWith(modesFor);

    expect(await hook(call('send_mcp_mail'), signal)).toMatchObject({ decision: 'ask' });
    expect(await hook(call('delete_mcp_mail'), signal)).toMatchObject({ decision: 'deny' });
    expect(await hook(call('search_mcp_mail'), signal)).toEqual({});
    expect(await hook(call('unknown_mcp_mail'), signal)).toMatchObject({ decision: 'ask' });
    expect(await hook(call('lookup_mcp_other'), signal)).toEqual({});
    expect(await hook(call('web_search'), signal)).toEqual({});
    expect(modesFor).toHaveBeenCalledTimes(2);
    expect(modesFor).toHaveBeenCalledWith({ tenantId: 'tenant-a', userId: 'u1', server: 'mail' });
  });

  it('denies when the policy cannot be read and reads it again on the next call', async () => {
    const modesFor = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ send: 'allow' });
    const hook = hookWith(modesFor);
    expect(await hook(call('send_mcp_mail'), signal)).toMatchObject({ decision: 'deny' });
    expect(await hook(call('send_mcp_mail'), signal)).toEqual({});
  });
});

describe('tool policy over the database', () => {
  let mongoServer: MongoMemoryServer;
  let policy: ReturnType<typeof createMcpToolPolicyMethods>;
  const groups: Record<string, string[]> = {};
  const g1 = 'a'.repeat(24);
  const g2 = 'b'.repeat(24);

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    policy = createMcpToolPolicyMethods(mongoose);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.db?.dropDatabase();
    groups.alice = [g1];
    groups.bob = [];
  });

  /** Tenants the group lookups ran in; the platform API has no request tenant of its own. */
  const lookedUpIn: Array<string | undefined> = [];
  const resolver = () =>
    createToolPolicyResolver({
      policy,
      getUserGroupIds: async (id) => {
        lookedUpIn.push(tenantStorage.getStore()?.tenantId);
        return groups[id] ?? [];
      },
    });

  function handlers() {
    return createToolPolicyHandlers({
      policy,
      resolver: resolver(),
      findUserIdByOpenId: async (tenantId, subject) =>
        tenantId === 'tenant-a' && ['alice', 'bob'].includes(subject) ? subject : null,
      groupExists: async (id) => id === g1 || id === g2,
    });
  }

  interface MockRes {
    statusCode: number;
    body?: Record<string, unknown>;
  }
  function mockRes() {
    const res: MockRes & Record<string, unknown> = {
      statusCode: 200,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(data: Record<string, unknown>) {
        res.body = data;
        return res;
      },
      end() {
        return res;
      },
    };
    return res as unknown as Response & MockRes;
  }
  const platformReq = (params: Record<string, string>, query = {}, body: unknown = {}) =>
    ({ params, query, body, headers: {}, get: () => undefined }) as unknown as Request;
  const adminReq = (body: unknown, tenantId: string | undefined = 'tenant-a') =>
    ({
      body,
      params: {},
      query: {},
      headers: {},
      get: () => undefined,
      user: { _id: 'admin', id: 'admin', tenantId, role: 'ADMIN' },
    }) as unknown as ServerRequest;

  async function register() {
    const res = mockRes();
    await handlers().registerTools(
      platformReq(
        { server: 'mail' },
        {},
        {
          tools: [
            { name: 'search', readOnly: true, title: 'Search' },
            { name: 'send', description: 'Send a mail' },
          ],
        },
      ),
      res,
    );
    expect(res.statusCode).toBe(204);
  }

  it('registers tools and refuses invalid or duplicate lists', async () => {
    await register();
    const res = mockRes();
    await handlers().registerTools(
      platformReq({ server: 'mail' }, {}, { tools: [{ name: 'a' }, { name: 'a' }] }),
      res,
    );
    expect(res.statusCode).toBe(400);
    const bad = mockRes();
    await handlers().registerTools(platformReq({ server: 'm/x' }, {}, { tools: [] }), bad);
    expect(bad.statusCode).toBe(400);
  });

  it('answers a user modes after the tenant admin set rules', async () => {
    await register();
    for (const body of [
      { server: 'mail', tool: 'send', principalType: 'tenant', mode: 'off' },
      { server: 'mail', tool: 'send', principalType: 'group', principalId: g1, mode: 'allow' },
    ]) {
      const res = mockRes();
      await handlers().putRule(adminReq(body), res);
      expect(res.statusCode).toBe(200);
    }

    const alice = mockRes();
    await handlers().getUserModes(
      platformReq({ server: 'mail' }, { tenantId: 'tenant-a', subject: 'alice' }),
      alice,
    );
    expect(alice.body).toEqual({ modes: { search: 'allow', send: 'allow' } });
    expect(lookedUpIn[lookedUpIn.length - 1]).toBe('tenant-a');

    const bob = mockRes();
    await handlers().getUserModes(
      platformReq({ server: 'mail' }, { tenantId: 'tenant-a', subject: 'bob' }),
      bob,
    );
    expect(bob.body).toEqual({ modes: { search: 'allow', send: 'off' } });

    const stranger = mockRes();
    await handlers().getUserModes(
      platformReq({ server: 'mail' }, { tenantId: 'tenant-b', subject: 'alice' }),
      stranger,
    );
    expect(stranger.statusCode).toBe(404);

    const unknownServer = mockRes();
    await handlers().getUserModes(
      platformReq({ server: 'files' }, { tenantId: 'tenant-a', subject: 'alice' }),
      unknownServer,
    );
    expect(unknownServer.body).toEqual({ error: 'server_unknown' });
  });

  it('keeps rules inside the admin tenant and removes them with a null mode', async () => {
    await register();
    const put = async (body: unknown, tenantId?: string) => {
      const res = mockRes();
      await handlers().putRule(adminReq(body, tenantId), res);
      return res;
    };
    expect(
      (await put({ server: 'mail', tool: 'send', principalType: 'tenant', mode: 'off' }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await put(
          { server: 'mail', tool: 'send', principalType: 'tenant', mode: 'allow' },
          'tenant-b',
        )
      ).statusCode,
    ).toBe(200);

    const view = mockRes();
    await handlers().getPolicy(adminReq({}), view);
    expect(view.body).toMatchObject({
      tools: [
        { name: 'search', defaultMode: 'allow' },
        { name: 'send', defaultMode: 'confirm' },
      ],
      rules: [{ tool: 'send', principalType: 'tenant', mode: 'off' }],
    });

    expect(
      (await put({ server: 'mail', tool: 'send', principalType: 'tenant', mode: null })).statusCode,
    ).toBe(200);
    const after = mockRes();
    await handlers().getPolicy(adminReq({}), after);
    expect(after.body?.rules).toEqual([]);
  });

  it('refuses unknown tools, unknown groups, bad input and callers without a tenant', async () => {
    await register();
    const put = async (body: unknown, tenantId?: string) => {
      const res = mockRes();
      await handlers().putRule(adminReq(body, tenantId), res);
      return res;
    };
    expect(
      (await put({ server: 'mail', tool: 'drop', principalType: 'tenant', mode: 'off' })).body,
    ).toEqual({ error: 'tool_unknown' });
    expect(
      (
        await put({
          server: 'mail',
          tool: 'send',
          principalType: 'group',
          principalId: 'c'.repeat(24),
          mode: 'off',
        })
      ).body,
    ).toEqual({ error: 'group_unknown' });
    expect(
      (
        await put({
          server: 'mail',
          tool: 'send',
          principalType: 'group',
          principalId: 'x',
          mode: 'off',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await put({ server: 'mail', tool: 'send', principalType: 'tenant', mode: 'sometimes' }))
        .statusCode,
    ).toBe(400);
    const res = mockRes();
    await handlers().putRule(
      {
        ...adminReq({ server: 'mail', tool: 'send', principalType: 'tenant', mode: 'off' }),
        user: { id: 'x' },
      } as unknown as ServerRequest,
      res,
    );
    expect(res.statusCode).toBe(403);
  });
});
