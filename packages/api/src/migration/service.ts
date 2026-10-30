import { logger, emptyMigrationCounts, PLATFORM_REDIRECT_SCOPE } from '@librechat/data-schemas';
import type {
  ModelRef,
  ModelUsage,
  ModelRedirect,
  MigrationCounts,
  MigrationAudience,
  ModelMigrationMethods,
  RecordAuditEntryInput,
} from '@librechat/data-schemas';
import { agentProvidersFor, endpointTypeFor, findRedirect, resolveModelRedirect } from './redirect';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * Model migrations (fork-only): saves a redirect and rewrites what is stored with the old model,
 * for one tenant (its admin) or for every or listed tenants (the operator). The rewrite itself is
 * `migrateModelUsage` of data-schemas; this adds the checks, the cache invalidation and the audit
 * entries.
 */

export type MigrationStore = Pick<
  ModelMigrationMethods,
  | 'upsertModelRedirect'
  | 'recordModelMigrationRun'
  | 'migrateModelUsage'
  | 'previewModelMigration'
  | 'countModelUsage'
  | 'getModelRedirects'
>;

/** An audit event, recorded with the caller's actor and request context. */
export type MigrationAuditEvent = Omit<RecordAuditEntryInput, 'actor' | 'context'>;

export interface ModelMigrationServiceDeps {
  store: MigrationStore;
  /** Drops merged configs (one tenant, or every tenant without an id). */
  invalidateConfig(tenantId?: string): Promise<void>;
  /** Evicts a user's cached auth documents. */
  invalidateUser(userId: string): Promise<void>;
}

/** Who a migration is for: the operator's (`platform`) or one tenant's. */
export type MigrationScope = { tenantId: string } | { platform: true; tenantIds?: string[] };

export interface MigrationRun {
  scope: MigrationScope;
  from: ModelRef;
  to: ModelRef;
  /** Recorded on the redirect. */
  createdBy?: string;
  /** Records one audit event; called for each tenant whose documents changed. */
  audit(event: MigrationAuditEvent): Promise<void>;
}

export interface MigrationView {
  id: string;
  scope: 'platform' | 'tenant';
  tenantIds?: string[];
  from: ModelRef;
  to: ModelRef;
  at: string;
  counts: MigrationCounts;
}

export type MigrationOutcome =
  | { ok: true; migration: MigrationView }
  | { ok: false; error: { code: 'same_model' | 'redirect_cycle' } };

export function audienceOf(scope: MigrationScope): MigrationAudience {
  if ('tenantId' in scope) return { tenantId: scope.tenantId };
  return scope.tenantIds ? { tenantIds: scope.tenantIds } : { all: true };
}

const sameRef = (a: ModelRef, b: ModelRef) => a.endpoint === b.endpoint && a.model === b.model;

/** Runs `fn` over `items`, at most `limit` at a time. */
async function inBatches<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
}

/** A redirect as the operator and admin APIs answer it. */
export interface RedirectView {
  id: string;
  scope: 'platform' | 'tenant';
  tenantIds?: string[];
  from: ModelRef;
  to: ModelRef;
  lastRun?: { at: string; counts: MigrationCounts };
  updatedAt?: string;
}

export function redirectView(redirect: ModelRedirect): RedirectView {
  return {
    id: redirect.redirectId,
    scope: redirect.scope === PLATFORM_REDIRECT_SCOPE ? ('platform' as const) : ('tenant' as const),
    ...(redirect.tenantIds && { tenantIds: redirect.tenantIds }),
    from: redirect.from,
    to: redirect.to,
    ...(redirect.lastRun && {
      lastRun: { at: redirect.lastRun.at.toISOString(), counts: redirect.lastRun.counts },
    }),
    ...(redirect.updatedAt && { updatedAt: redirect.updatedAt.toISOString() }),
  };
}

export interface ModelMigrationService {
  run(input: MigrationRun): Promise<MigrationOutcome>;
  preview(scope: MigrationScope, from: ModelRef): Promise<MigrationCounts>;
  usage(scope: MigrationScope, models: ModelRef[]): Promise<ModelUsage[]>;
  /**
   * Whether every tenant of the scope that could use `ref` is covered by a redirect: the tenant's
   * own or the operator's for it, or, for a platform scope, an operator redirect for each listed
   * tenant or for every tenant.
   */
  hasRedirect(scope: MigrationScope, ref: ModelRef): boolean;
}

export function createModelMigrationService(
  deps: ModelMigrationServiceDeps,
): ModelMigrationService {
  const { store } = deps;

  async function invalidate(configTenants: string[], userIds: string[]) {
    const results = await Promise.allSettled([
      ...configTenants.map((tenantId) => deps.invalidateConfig(tenantId || undefined)),
      inBatches(userIds, 20, (userId) => deps.invalidateUser(userId)),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn(
          '[modelMigration] cache invalidation failed',
          getSafeErrorMetadata(result.reason),
        );
      }
    }
  }

  async function run(input: MigrationRun): Promise<MigrationOutcome> {
    const { scope, from, to } = input;
    if (sameRef(from, to)) return { ok: false, error: { code: 'same_model' } };
    const tenantId = 'tenantId' in scope ? scope.tenantId : undefined;
    /* The successor must not lead back to the old model, or both would point at each other. */
    const onward = resolveModelRedirect(store.getModelRedirects(), tenantId, to);
    if (onward && (sameRef(onward.to, from) || onward.applied.some((r) => sameRef(r.to, from)))) {
      return { ok: false, error: { code: 'redirect_cycle' } };
    }
    const redirect = await store.upsertModelRedirect({
      scope: tenantId ?? PLATFORM_REDIRECT_SCOPE,
      ...('platform' in scope && scope.tenantIds && { tenantIds: scope.tenantIds }),
      from,
      to,
      createdBy: input.createdBy,
    });
    const at = new Date();
    const result = await store.migrateModelUsage({
      migrationId: redirect.redirectId,
      from,
      to,
      agentProviders: agentProvidersFor(from.endpoint),
      toEndpointType: endpointTypeFor(to.endpoint),
      audience: audienceOf(scope),
      at,
    });
    await store.recordModelMigrationRun(redirect.redirectId, result.counts, at);
    await invalidate(result.configTenants, result.userIds);

    const event = (
      counts: MigrationCounts,
      forTenant: string | undefined,
    ): MigrationAuditEvent => ({
      action: 'model.migrated',
      outcome: 'success',
      severity: 'info',
      tenantId: forTenant,
      target: { type: 'model', id: `${from.endpoint}/${from.model}` },
      metadata: {
        migrationId: redirect.redirectId,
        to: `${to.endpoint}/${to.model}`,
        scope: tenantId ? 'tenant' : 'platform',
        ...counts,
      },
    });
    const tenants = new Map(Object.entries(result.byTenant).filter(([id]) => id !== ''));
    if (tenantId) tenants.set(tenantId, result.byTenant[tenantId] ?? emptyMigrationCounts());
    for (const [id, counts] of tenants) {
      await input.audit(event(counts, id));
    }
    if (!tenantId) await input.audit(event(result.counts, undefined));

    return {
      ok: true,
      migration: {
        id: redirect.redirectId,
        scope: tenantId ? 'tenant' : 'platform',
        ...(redirect.tenantIds && { tenantIds: redirect.tenantIds }),
        from,
        to,
        at: at.toISOString(),
        counts: result.counts,
      },
    };
  }

  function hasRedirect(scope: MigrationScope, ref: ModelRef): boolean {
    const redirects = store.getModelRedirects();
    if ('tenantId' in scope) return findRedirect(redirects, scope.tenantId, ref) != null;
    if (findRedirect(redirects, undefined, ref)) return true;
    const listed = scope.tenantIds;
    return (
      listed != null && listed.length > 0 && listed.every((id) => findRedirect(redirects, id, ref))
    );
  }

  return {
    run,
    hasRedirect,
    preview: (scope, from) =>
      store.previewModelMigration(from, agentProvidersFor(from.endpoint), audienceOf(scope)),
    usage: (scope, models) =>
      store.countModelUsage(
        models.map((ref) => ({ ...ref, agentProviders: agentProvidersFor(ref.endpoint) })),
        audienceOf(scope),
      ),
  };
}
