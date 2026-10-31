const { SYSTEM_TENANT_ID } = require('@librechat/data-schemas');

const mockSeen = {};
jest.mock('@librechat/api', () => ({
  logAgentMigrationWarning: jest.fn(),
  logPromptMigrationWarning: jest.fn(),
  checkAgentPermissionsMigration: jest.fn(async () => {
    mockSeen.agents = jest.requireActual('@librechat/data-schemas').getTenantId();
    return {};
  }),
  checkPromptPermissionsMigration: jest.fn(async () => {
    mockSeen.prompts = jest.requireActual('@librechat/data-schemas').getTenantId();
    return {};
  }),
}));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  warnOnMissingSearchTokens: jest.fn(async () => undefined),
}));
jest.mock('~/models', () => ({ findRoleByIdentifier: jest.fn() }));

const { checkMigrations } = require('./migration');

describe('checkMigrations (fork)', () => {
  it('checks the permission migrations of every tenant as system', async () => {
    await checkMigrations();

    expect(mockSeen.agents).toBe(SYSTEM_TENANT_ID);
    expect(mockSeen.prompts).toBe(SYSTEM_TENANT_ID);
  });
});
