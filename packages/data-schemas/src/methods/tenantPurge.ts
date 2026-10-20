import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';

/**
 * Removes a tenant's data (fork-only, the operator's tenant deletion). The caller erases each
 * user's data first (files, shared links, MCP sessions) through the user erasure cascade; this
 * then removes every document that still carries the tenant's id, in every model with a
 * `tenantId` path. The audit log is append-only and stays; its retention purge removes the
 * tenant's entries in time.
 */

/** Models the sweep leaves alone. */
const KEPT_MODELS = new Set(['AuditLog']);

export interface TenantUserTarget {
  id: string;
  role?: string;
  tenantId: string;
  idOnTheSource?: string | null;
  profile: { name?: string; username?: string; email?: string; provider?: string };
}

export interface TenantPurgeMethods {
  /** The tenant's users, as the erasure cascade needs them. */
  listTenantUserTargets(tenantId: string): Promise<TenantUserTarget[]>;
  /** Deleted documents per model, for every model holding tenant data. */
  purgeTenantDocuments(tenantId: string): Promise<Record<string, number>>;
}

const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** A purge must never run with an empty or system tenant: its filter would match too much. */
function assertTenant(tenantId: string): void {
  if (!TENANT_ID.test(tenantId) || tenantId === SYSTEM_TENANT_ID) {
    throw new Error('A tenant purge needs a valid tenant id');
  }
}

interface UserRow {
  _id: { toString(): string };
  role?: string;
  idOnTheSource?: string | null;
  name?: string;
  username?: string;
  email?: string;
  provider?: string;
}

export function createTenantPurgeMethods(mongoose: typeof import('mongoose')): TenantPurgeMethods {
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    tenantStorage.run({ ...tenantStorage.getStore(), tenantId }, fn);

  return {
    async listTenantUserTargets(tenantId) {
      assertTenant(tenantId);
      const User = mongoose.models.User;
      if (!User) return [];
      const rows = await inTenant(
        tenantId,
        async () =>
          await User.find({ tenantId }, 'role idOnTheSource name username email provider').lean<
            UserRow[]
          >(),
      );
      return rows.map((row) => ({
        id: row._id.toString(),
        role: row.role,
        tenantId,
        idOnTheSource: row.idOnTheSource ?? null,
        profile: {
          name: row.name,
          username: row.username,
          email: row.email,
          provider: row.provider,
        },
      }));
    },

    async purgeTenantDocuments(tenantId) {
      assertTenant(tenantId);
      const counts: Record<string, number> = {};
      for (const name of mongoose.modelNames()) {
        const model = mongoose.models[name];
        if (KEPT_MODELS.has(name) || !model?.schema.path('tenantId')) continue;
        const { deletedCount } = await inTenant(
          tenantId,
          async () => await model.deleteMany({ tenantId }),
        );
        if (deletedCount > 0) counts[name] = deletedCount;
      }
      return counts;
    },
  };
}
