import {
  getCatalogLockIssues,
  getCatalogLockEntryIssues,
  getCatalogLockChangeIssues,
  getCatalogLockTombstoneIssue,
} from './catalogLock';

const catalog = {
  endpoints: {
    custom: [
      {
        name: 'Mistral EU',
        apiKey: '${MISTRAL_API_KEY}',
        baseURL: 'https://api.mistral.ai/v1',
        models: { default: ['mistral-small-latest', 'mistral-large-latest'], fetch: false },
      },
      {
        name: 'Fetched',
        apiKey: '${OTHER_KEY}',
        baseURL: 'https://example.com/v1',
        models: { default: ['a'], fetch: true },
      },
    ],
  },
  mcpServers: {
    gmail: { type: 'streamable-http', url: 'https://gmail.mcp.example/mcp' },
    drive: { type: 'streamable-http', url: 'https://drive.mcp.example/mcp' },
  },
};

const codes = (fields: Record<string, unknown>) =>
  getCatalogLockIssues(fields, catalog).map(({ path, code }) => ({ path, code }));

describe('getCatalogLockIssues', () => {
  it('accepts narrowing a catalog endpoint to a subset of its models', () => {
    expect(
      codes({
        'endpoints.custom': [{ name: 'Mistral EU', models: { default: ['mistral-small-latest'] } }],
      }),
    ).toEqual([]);
    expect(
      codes({ endpoints: { custom: [{ name: 'Mistral EU', models: { default: [] } }] } }),
    ).toEqual([]);
  });

  it('accepts sections without endpoints or environment references', () => {
    expect(codes({ 'interface.customWelcome': 'Hello', balance: { enabled: true } })).toEqual([]);
  });

  it('refuses models the catalog does not offer', () => {
    expect(
      codes({
        'endpoints.custom': [
          { name: 'Mistral EU', models: { default: ['mistral-small-latest', 'gpt-x'] } },
        ],
      }),
    ).toEqual([{ path: 'endpoints.custom.0.models.default.1', code: 'catalog_unknown_model' }]);
  });

  it('refuses redirecting a catalog endpoint or changing its other fields', () => {
    expect(
      codes({
        'endpoints.custom': [
          { name: 'Mistral EU', baseURL: 'https://attacker.example', models: { fetch: true } },
        ],
      }),
    ).toEqual([
      { path: 'endpoints.custom.0.baseURL', code: 'catalog_field_locked' },
      { path: 'endpoints.custom.0.models.fetch', code: 'catalog_field_locked' },
    ]);
  });

  it('refuses endpoints outside the catalog and every other endpoint section', () => {
    expect(
      codes({
        endpoints: {
          custom: [
            { name: 'Mine', baseURL: 'https://attacker.example', models: { default: ['x'] } },
          ],
          openAI: { titleModel: 'x' },
        },
      }),
    ).toEqual([
      { path: 'endpoints.openAI', code: 'catalog_endpoint_locked' },
      { path: 'endpoints.custom.0.name', code: 'catalog_unknown_endpoint' },
    ]);
  });

  it('accepts switching conversation pull requests on or off (fork)', () => {
    expect(codes({ 'endpoints.agents.pullRequests.enabled': true })).toEqual([]);
    expect(codes({ endpoints: { agents: { pullRequests: { enabled: false } } } })).toEqual([]);
  });

  it('refuses every other agents endpoint field, and a pull request switch that is no boolean', () => {
    expect(
      codes({
        endpoints: {
          agents: {
            pullRequests: { enabled: 'yes', allowAllRepositories: true, token: 'ghp_x' },
            capabilities: ['execute_code'],
          },
        },
      }),
    ).toEqual([
      { path: 'endpoints.agents.pullRequests.enabled', code: 'catalog_field_locked' },
      { path: 'endpoints.agents.pullRequests.allowAllRepositories', code: 'catalog_field_locked' },
      { path: 'endpoints.agents.pullRequests.token', code: 'catalog_field_locked' },
      { path: 'endpoints.agents.capabilities', code: 'catalog_field_locked' },
    ]);
    expect(codes({ 'endpoints.agents': true })).toEqual([
      { path: 'endpoints.agents', code: 'catalog_field_locked' },
    ]);
  });

  it('accepts a page limit per search that is a whole number of at least 0 (fork)', () => {
    expect(codes({ 'webSearch.maxPagesPerSearch': 0 })).toEqual([]);
    expect(codes({ webSearch: { maxPagesPerSearch: 3 } })).toEqual([]);
  });

  it.each([[-1], [2.5], ['3'], [null], [true]])(
    'refuses a page limit per search of %j (fork)',
    (pages) => {
      expect(codes({ 'webSearch.maxPagesPerSearch': pages })).toEqual([
        { path: 'webSearch.maxPagesPerSearch', code: 'catalog_field_locked' },
      ]);
      expect(
        getCatalogLockEntryIssues(['webSearch', 'maxPagesPerSearch'], pages, catalog).map(
          ({ path, code }) => ({ path, code }),
        ),
      ).toEqual([{ path: 'webSearch.maxPagesPerSearch', code: 'catalog_field_locked' }]);
    },
  );

  it('refuses narrowing an endpoint whose models are fetched at runtime', () => {
    expect(
      codes({ 'endpoints.custom': [{ name: 'Fetched', models: { default: ['a'] } }] }),
    ).toEqual([{ path: 'endpoints.custom.0.models.default', code: 'catalog_models_fetched' }]);
  });

  it('refuses environment references anywhere, including inside longer strings', () => {
    expect(
      codes({
        'webSearch.serperApiKey': '${JWT_SECRET}',
        mcpServers: { x: { headers: { Authorization: 'Bearer ${MISTRAL_API_KEY}' } } },
      }),
    ).toEqual([
      { path: 'webSearch.serperApiKey', code: 'catalog_env_reference' },
      { path: 'mcpServers.x.headers.Authorization', code: 'catalog_env_reference' },
      { path: 'mcpServers.x', code: 'catalog_unknown_mcp_server' },
    ]);
  });

  it('accepts switching a catalog MCP server off or out of the chat menu', () => {
    expect(codes({ 'mcpServers.gmail.enabled': false })).toEqual([]);
    expect(codes({ 'mcpServers.gmail': { enabled: true, chatMenu: false } })).toEqual([]);
    expect(codes({ mcpServers: { gmail: { enabled: false }, drive: { chatMenu: true } } })).toEqual(
      [],
    );
    expect(codes({ mcpServers: {} })).toEqual([]);
  });

  it('refuses redirecting a catalog MCP server or changing its other fields', () => {
    expect(
      codes({
        mcpServers: {
          gmail: {
            url: 'https://attacker.example/mcp',
            headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
            enabled: 'no',
          },
        },
        'mcpConfig.drive.type': 'sse',
        'mcpServers.drive.chatMenu': true,
      }),
    ).toEqual([
      { path: 'mcpServers.gmail.url', code: 'catalog_field_locked' },
      { path: 'mcpServers.gmail.headers', code: 'catalog_field_locked' },
      { path: 'mcpServers.gmail.enabled', code: 'catalog_field_locked' },
      { path: 'mcpConfig.drive.type', code: 'catalog_field_locked' },
    ]);
  });

  it('refuses switching file outputs on for a catalog MCP server (fork)', () => {
    expect(codes({ 'mcpServers.gmail.fileOutputs': true })).toEqual([
      { path: 'mcpServers.gmail.fileOutputs', code: 'catalog_field_locked' },
    ]);
    expect(codes({ mcpServers: { gmail: { fileOutputs: { maxBytes: 1 } } } })).toEqual([
      { path: 'mcpServers.gmail.fileOutputs', code: 'catalog_field_locked' },
    ]);
    expect(getCatalogLockTombstoneIssue('mcpServers.gmail.fileOutputs')).toEqual(
      expect.objectContaining({ code: 'catalog_field_locked' }),
    );
  });

  it('refuses MCP servers outside the catalog and non-object MCP sections', () => {
    expect(
      codes({ 'mcpServers.mine': { type: 'streamable-http', url: 'https://x.example' } }),
    ).toEqual([{ path: 'mcpServers.mine', code: 'catalog_unknown_mcp_server' }]);
    expect(codes({ 'mcpServers.mine.enabled': true })).toEqual([
      { path: 'mcpServers.mine', code: 'catalog_unknown_mcp_server' },
    ]);
    expect(codes({ mcpServers: ['gmail'] })).toEqual([
      { path: 'mcpServers', code: 'catalog_field_locked' },
    ]);
    expect(codes({ 'mcpServers.gmail': false })).toEqual([
      { path: 'mcpServers.gmail', code: 'catalog_field_locked' },
    ]);
  });
});

describe('getCatalogLockTombstoneIssue', () => {
  it('allows tombstones of the MCP switches and of other sections', () => {
    expect(getCatalogLockTombstoneIssue('mcpServers.gmail.enabled')).toBeNull();
    expect(getCatalogLockTombstoneIssue('mcpConfig.gmail.chatMenu')).toBeNull();
    expect(getCatalogLockTombstoneIssue('interface.customWelcome')).toBeNull();
  });

  it('refuses any other tombstone under the MCP sections', () => {
    for (const path of ['mcpServers', 'mcpServers.gmail', 'mcpServers.gmail.url']) {
      expect(getCatalogLockTombstoneIssue(path)).toEqual(
        expect.objectContaining({ path, code: 'catalog_field_locked' }),
      );
    }
    expect(getCatalogLockTombstoneIssue('mcpServers.gmail.headers.Authorization')).toEqual(
      expect.objectContaining({ code: 'catalog_field_locked' }),
    );
  });
});

describe('getCatalogLockEntryIssues', () => {
  const entryCodes = (segments: string[], value: unknown) =>
    getCatalogLockEntryIssues(segments, value, catalog).map(({ path, code }) => ({ path, code }));

  it('judges a write by its segments, as a PATCH of the same path', () => {
    expect(entryCodes(['mcpServers', 'gmail', 'enabled'], false)).toEqual([]);
    expect(entryCodes(['mcpServers', 'gmail', 'url'], 'https://attacker.example/mcp')).toEqual([
      { path: 'mcpServers.gmail.url', code: 'catalog_field_locked' },
    ]);
    expect(
      entryCodes(['endpoints', 'custom'], [{ name: 'Mistral EU', baseURL: 'https://x.example' }]),
    ).toEqual([{ path: 'endpoints.custom.0.baseURL', code: 'catalog_field_locked' }]);
  });

  it('keeps a key that contains a dot as one key', () => {
    expect(entryCodes(['mcpServers', 'my.server'], { enabled: true })).toEqual([
      { path: 'mcpServers.my.server', code: 'catalog_unknown_mcp_server' },
    ]);
    expect(entryCodes(['interface', 'a.b'], '${SECRET}')).toEqual([
      { path: 'interface.a.b', code: 'catalog_env_reference' },
    ]);
  });

  it('judges a whole document for empty segments', () => {
    expect(entryCodes([], { webSearch: { serperApiKey: '${JWT_SECRET}' } })).toEqual([
      { path: 'webSearch.serperApiKey', code: 'catalog_env_reference' },
    ]);
  });
});

describe('getCatalogLockChangeIssues', () => {
  const changeCodes = (change: Parameters<typeof getCatalogLockChangeIssues>[0]) =>
    getCatalogLockChangeIssues(change, catalog).map(({ path, code }) => ({ path, code }));

  it('judges a set as a PATCH entry', () => {
    expect(
      changeCodes({ op: 'set', segments: ['mcpServers', 'gmail', 'chatMenu'], value: true }),
    ).toEqual([]);
    expect(
      changeCodes({ op: 'set', segments: ['endpoints', 'openAI'], value: { apiKey: 'x' } }),
    ).toEqual([{ path: 'endpoints.openAI', code: 'catalog_endpoint_locked' }]);
  });

  it('judges an upserted entry as the array holding it', () => {
    expect(
      changeCodes({
        op: 'upsertEntry',
        segments: ['endpoints', 'custom'],
        value: { name: 'Mistral EU', models: { default: ['mistral-small-latest'] } },
      }),
    ).toEqual([]);
    expect(
      changeCodes({
        op: 'upsertEntry',
        segments: ['endpoints', 'custom'],
        value: { name: 'Mine', baseURL: 'https://attacker.example' },
      }),
    ).toEqual([{ path: 'endpoints.custom.0.name', code: 'catalog_unknown_endpoint' }]);
  });

  it('judges a tombstone as the tombstone route and refuses renames of locked entries', () => {
    expect(changeCodes({ op: 'tombstone', segments: ['mcpServers', 'gmail', 'enabled'] })).toEqual(
      [],
    );
    expect(changeCodes({ op: 'tombstone', segments: ['mcpServers', 'gmail'] })).toEqual([
      { path: 'mcpServers.gmail', code: 'catalog_field_locked' },
    ]);
    expect(changeCodes({ op: 'rename', segments: ['endpoints', 'custom'] })).toEqual([
      { path: 'endpoints.custom', code: 'catalog_field_locked' },
    ]);
    expect(changeCodes({ op: 'rename', segments: ['mcpServers'] })).toEqual([
      { path: 'mcpServers', code: 'catalog_field_locked' },
    ]);
  });

  it('lets unsets and entry removals through, which only narrow', () => {
    expect(changeCodes({ op: 'unset', segments: ['mcpServers', 'gmail', 'url'] })).toEqual([]);
    expect(changeCodes({ op: 'removeEntry', segments: ['endpoints', 'custom'] })).toEqual([]);
  });
});
