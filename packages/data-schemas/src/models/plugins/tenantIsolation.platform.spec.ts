import mongoose from 'mongoose';
import { createMethods } from '~/methods';
import { createModels } from '../index';

/**
 * Fork: every collection is either tenant-scoped or deliberately shared, and says which.
 *
 * Upstream's coverage spec checks the models `createModels` registers that carry a `tenantId`
 * field. The fork adds collections inside its methods (platform catalog, pricing, banners, tool
 * policy, model migrations …), which only `createMethods` registers, and some of them have no
 * `tenantId` at all because they belong to the operator. A new collection that forgets its
 * tenancy would be shared by every tenant without anyone noticing; this guard makes that a
 * failing test that names the model.
 */
const APPLIED = Symbol.for('librechat:tenantIsolation');

/** Models with a `tenantId` field that scope it themselves (upstream's list, plus the fork's). */
const MANUAL_TENANT_SCOPING: Record<string, string> = {
  SystemGrant: 'upstream: scopes tenancy inside its methods',
  SkillSyncStatus: 'upstream: app-wide and tenant rows, explicit filters',
  AuditLog: 'upstream: tenant filter from the caller, platform entries without tenantId',
  RefreshTokenBridge: 'upstream: tenant from the signed marker cookie',
  PlatformSignIn:
    'fork: sign-in times per tenant for the operator overview, read only as totals across tenants',
};

/**
 * Models without a `tenantId` field: shared by design. Each reason says how tenants are kept apart
 * where it matters.
 */
const SHARED: Record<string, string> = {
  OpenIDRefreshFlight: 'upstream: per refresh token, no tenant data',
  ResourceLock: 'upstream: process locks',
  SkillSyncCredential: 'upstream: deployment-wide skill sync credential',
  PlatformProvider:
    'fork: the operator catalog; tenants reach a provider through TenantCatalog or allTenants',
  PlatformPricing: 'fork: operator prices, `scope` names the default or one tenant',
  PlatformBanner: 'fork: operator banners, `tenantIds` names the tenants or all',
  PlatformAgent: 'fork: operator agent definitions; tenants get scoped copies (Agent)',
  PlatformMcpPrice:
    'fork: operator prices per MCP server; subscriptions are scoped (McpSubscription)',
  PlatformMcpTool: 'fork: the tools MCP servers registered; modes are scoped (McpToolPolicy)',
  ModelRedirect: 'fork: `scope` and `tenantIds` name the platform or the tenants a redirect is for',
  ModelMigrationSeen:
    'fork: which user saw a migration notice, keyed by the globally unique user id',
};

const isScoped = (model: mongoose.Model<unknown>) =>
  (model.schema as unknown as { [key: symbol]: boolean })[APPLIED] === true;

describe('tenancy of every collection (fork)', () => {
  beforeAll(() => {
    createModels(mongoose);
    createMethods(mongoose);
  });

  it('scopes every model by tenant, or lists it as manually scoped or shared with a reason', () => {
    const unexplained: string[] = [];
    for (const [name, model] of Object.entries(mongoose.models)) {
      if (isScoped(model) || name in MANUAL_TENANT_SCOPING || name in SHARED) continue;
      unexplained.push(
        `${name} (${model.schema.path('tenantId') ? 'tenantId without the plugin' : 'no tenantId'})`,
      );
    }
    expect(unexplained).toEqual([]);
  });

  it('keeps both lists accurate', () => {
    for (const name of Object.keys(MANUAL_TENANT_SCOPING)) {
      const model = mongoose.models[name];
      expect({ name, registered: Boolean(model) }).toEqual({ name, registered: true });
      expect({
        name,
        tenantId: Boolean(model!.schema.path('tenantId')),
        scoped: isScoped(model!),
      }).toEqual({ name, tenantId: true, scoped: false });
    }
    for (const name of Object.keys(SHARED)) {
      const model = mongoose.models[name];
      expect({ name, registered: Boolean(model) }).toEqual({ name, registered: true });
      expect({ name, tenantId: Boolean(model!.schema.path('tenantId')) }).toEqual({
        name,
        tenantId: false,
      });
    }
  });
});
