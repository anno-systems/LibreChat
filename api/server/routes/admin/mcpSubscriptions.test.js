const express = require('express');
const request = require('supertest');

const middlewareCalls = [];
const mockStore = {};

jest.mock('@librechat/data-schemas', () => ({
  SystemCapabilities: {
    ACCESS_ADMIN: 'access:admin',
    READ_CONFIGS: 'read:configs',
    MANAGE_MCP_SERVERS: 'manage:mcp_servers',
  },
}));

jest.mock('@librechat/api', () => ({
  createMcpSubscriptionHandlers: ({ store }) => ({
    listSubscriptions: async (req, res) => res.json({ list: req.user.tenantId, store: !!store }),
    subscribe: async (req, res) => res.json({ subscribed: req.params.server, body: req.body }),
    unsubscribe: async (req, res) => res.json({ unsubscribed: req.params.server }),
  }),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: (capability) => (_req, _res, next) => {
    middlewareCalls.push(capability);
    next();
  },
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    middlewareCalls.push('jwt');
    req.user = { id: 'admin-1', tenantId: 'tenant-a' };
    next();
  },
}));

jest.mock('~/models', () => mockStore);

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/admin/mcp-subscriptions', require('./mcpSubscriptions'));
  return server;
}

describe('admin MCP subscription routes', () => {
  beforeEach(() => {
    middlewareCalls.length = 0;
  });

  it('lists with READ_CONFIGS', async () => {
    const res = await request(app()).get('/api/admin/mcp-subscriptions');

    expect(res.body).toEqual({ list: 'tenant-a', store: true });
    expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'read:configs']);
  });

  it('subscribes and ends a subscription with MANAGE_MCP_SERVERS', async () => {
    const put = await request(app())
      .put('/api/admin/mcp-subscriptions/jira')
      .send({ monthlyPrice: 20, currency: 'EUR' });
    expect(put.body).toEqual({
      subscribed: 'jira',
      body: { monthlyPrice: 20, currency: 'EUR' },
    });
    expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'manage:mcp_servers']);

    middlewareCalls.length = 0;
    const del = await request(app()).delete('/api/admin/mcp-subscriptions/jira');
    expect(del.body).toEqual({ unsubscribed: 'jira' });
    expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'manage:mcp_servers']);
  });
});
