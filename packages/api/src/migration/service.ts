import { randomUUID } from 'node:crypto';
import { logger, emptyMigrationCounts, PLATFORM_REDIRECT_SCOPE } from '@librechat/data-schemas';
import type {
  ModelRef,
  ModelUsage,
  ModelRedirect,
  MigrationCounts,
  MigrationAudience,
  SuccessorEnabled,
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
  | 'enableSuccessor'
  | 'retargetModelRedirects'
  | 'findGroupMemberUsers'
>;

/** An audit event, recorded with the caller's actor and request context. */
export type MigrationAuditEvent = Omit<RecordAuditEntryInput, 'actor' | 'context'>;

export interface ModelMigrationServiceDeps {
  store: MigrationStore;
  /** Drops merged configs (one tenant, or every tenant without an id). */
  invalidateConfig(tenantId?: string): Promise<void>;
  /** Evicts a user's cached auth documents. */
  invalidateUser(userId: string): Promise<void>;
  /**
   * The display name of a model, when the configuration names one (a model spec's label);
   * labels given with a migration win. Absent, notices show the model id.
   */
  labelOf?(ref: ModelRef, tenantId?: string): Promise<string | undefined>;
  /**
   * Whether `endpoint` is a platform provider assigned per tenant (not offered to all), so an
   * operator migration adds the successor to the assignments of tenants that had the old model.
   */
  isAssignedProvider?(endpoint: string): Promise<boolean>;
}

/**
 * Users of a tenant a migration leaves out: the members of `groupIds` (resolved to `userIds`),
 * who keep the old model because it stays enabled for those groups.
 */
export interface MigrationExcept {
  groupIds: string[];
  userIds: string[];
}

/**
 * Who a migration is for: the operator's (`platform`) or one tenant's. A tenant scope with
 * `except` is a scoped migration: it rewrites only what other users own, leaves config documents
 * alone and stores no redirect, since the old model stays valid for the excepted groups.
 */
export type MigrationScope =
  | { tenantId: string; except?: MigrationExcept }
  | { platform: true; tenantIds?: string[] };

export type ScopeOutcome =
  | { ok: true; scope: MigrationScope }
  | { ok: false; error: { code: 'unknown_group'; groupIds: string[] } };

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
  /**
   * The redirect's id, which notices carry too. A scoped migration (`exceptGroups`) stores no
   * redirect; its id (same `mm_` form) only names the run in notices and the audit log.
   */
  id: string;
  scope: 'platform' | 'tenant';
  tenantIds?: string[];
  from: ModelRef;
  to: ModelRef;
  /**
   * Where documents were rewritten to: `to`, or the end of the chain that continues from it
   * (A→B with B→C rewrites to C). For listed tenants with different chains, the first group's.
   */
  rewrittenTo: ModelRef;
  at: string;
  counts: MigrationCounts;
  /** Operator migrations: tenants whose config documents or assignment gained the successor. */
  successorEnabled?: Record<string, SuccessorEnabled>;
  /** Scoped migrations: the groups whose members were left out; no redirect was stored. */
  exceptGroups?: string[];
}

export type MigrationOutcome =
  | { ok: true; migration: MigrationView }
  | { ok: false; error: { code: 'same_model' | 'redirect_cycle' } };

interface RewriteGroup {
  audience: MigrationAudience;
  to: ModelRef;
}

/** The group a tenant was rewritten in; the first for a migration of every tenant. */
function groupOf(groups: RewriteGroup[], tenantId: string): RewriteGroup {
  return (
    groups.find((g) => 'tenantIds' in g.audience && g.audience.tenantIds.includes(tenantId)) ??
    groups[0]
  );
}

export function audienceOf(scope: MigrationScope): MigrationAudience {
  if ('tenantId' in scope) {
    return scope.except
      ? { tenantId: scope.tenantId, exceptUsers: scope.except.userIds }
      : { tenantId: scope.tenantId };
  }
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
  /** A tenant's scope, leaving out the members of `exceptGroups` when given. */
  tenantScope(tenantId: string, exceptGroups?: string[]): Promise<ScopeOutcome>;
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

  /** Labels given with the migration, else the configuration's, else none. */
  async function labelled(ref: ModelRef, tenantId?: string): Promise<ModelRef> {
    if (ref.label || !deps.labelOf) return ref;
    const label = await deps.labelOf(ref, tenantId).catch(() => undefined);
    return label ? { ...ref, label } : ref;
  }

  /** The rewrite target per group of tenants: the end of the chain that continues from `to`. */
  function rewriteGroups(scope: MigrationScope, to: ModelRef): RewriteGroup[] {
    const redirects = store.getModelRedirects();
    const end = (tenantId?: string) => resolveModelRedirect(redirects, tenantId, to)?.to ?? to;
    if ('tenantId' in scope) {
      return [{ audience: audienceOf(scope), to: end(scope.tenantId) }];
    }
    if (!scope.tenantIds) return [{ audience: { all: true }, to: end() }];
    const groups = new Map<string, RewriteGroup & { tenantIds: string[] }>();
    for (const tenantId of scope.tenantIds) {
      const target = end(tenantId);
      const key = `${target.endpoint}\u0000${target.model}`;
      const group = groups.get(key) ?? { audience: { tenantIds: [] }, tenantIds: [], to: target };
      group.tenantIds.push(tenantId);
      group.audience = { tenantIds: group.tenantIds };
      groups.set(key, group);
    }
    return [...groups.values()].map(({ audience, to: target }) => ({ audience, to: target }));
  }

  async function run(input: MigrationRun): Promise<MigrationOutcome> {
    const { scope } = input;
    if (sameRef(input.from, input.to)) return { ok: false, error: { code: 'same_model' } };
    const tenantId = 'tenantId' in scope ? scope.tenantId : undefined;
    /* The successor must not lead back to the old model, or both would point at each other. */
    const onward = resolveModelRedirect(store.getModelRedirects(), tenantId, input.to);
    if (
      onward &&
      (sameRef(onward.to, input.from) || onward.applied.some((r) => sameRef(r.to, input.from)))
    ) {
      return { ok: false, error: { code: 'redirect_cycle' } };
    }
    const [from, to] = await Promise.all([
      labelled(input.from, tenantId),
      labelled(input.to, tenantId),
    ]);
    const scopeName = tenantId ?? PLATFORM_REDIRECT_SCOPE;
    const listed = 'platform' in scope ? scope.tenantIds : undefined;
    const except = 'tenantId' in scope ? scope.except : undefined;
    /* The old model stays valid for the excepted groups, so a scoped migration redirects nothing. */
    const redirect = except
      ? null
      : await store.upsertModelRedirect({
          scope: scopeName,
          ...(listed && { tenantIds: listed }),
          from,
          to,
          createdBy: input.createdBy,
        });
    const migrationId = redirect?.redirectId ?? `mm_${randomUUID()}`;
    const at = new Date();
    const counts = emptyMigrationCounts();
    const byTenant: Record<string, MigrationCounts> = {};
    const enabled: Record<string, SuccessorEnabled> = {};
    const configTenants = new Set<string>();
    const userIds = new Set<string>();
    const groups = rewriteGroups(scope, to);
    for (const group of groups) {
      const target = sameRef(group.to, to) ? to : await labelled(group.to, tenantId);
      group.to = target;
      const result = await store.migrateModelUsage({
        migrationId,
        from,
        to: target,
        agentProviders: agentProvidersFor(from.endpoint),
        toEndpointType: endpointTypeFor(target.endpoint),
        audience: group.audience,
        at,
      });
      for (const kind of Object.keys(counts) as Array<keyof MigrationCounts>) {
        counts[kind] += result.counts[kind];
      }
      for (const [id, tenantCounts] of Object.entries(result.byTenant)) {
        byTenant[id] = tenantCounts;
      }
      result.configTenants.forEach((id) => configTenants.add(id));
      result.userIds.forEach((id) => userIds.add(id));
      /* Operator migrations keep tenants able to run what their documents now name. */
      if (!('tenantId' in group.audience)) {
        const assignProvider = (await deps.isAssignedProvider?.(target.endpoint)) ?? false;
        const changed = await store.enableSuccessor({
          from,
          to: target,
          audience: group.audience,
          assignProvider,
        });
        for (const [id, change] of Object.entries(changed)) {
          enabled[id] = change;
          configTenants.add(id);
        }
      }
    }
    if (redirect) {
      /* Redirects that ended at the old model now end where its documents went. */
      await store.retargetModelRedirects({
        scope: scopeName,
        ...(listed && { tenantIds: listed }),
        from,
        to: groups[0].to,
      });
      await store.recordModelMigrationRun(redirect.redirectId, counts, at);
    }
    await invalidate([...configTenants], [...userIds]);

    const event = (
      tenantCounts: MigrationCounts,
      forTenant: string | undefined,
    ): MigrationAuditEvent => {
      const change = forTenant ? enabled[forTenant] : undefined;
      const target = forTenant ? groupOf(groups, forTenant).to : groups[0].to;
      return {
        action: 'model.migrated',
        outcome: 'success',
        severity: 'info',
        tenantId: forTenant,
        target: { type: 'model', id: `${from.endpoint}/${from.model}` },
        metadata: {
          migrationId,
          to: `${to.endpoint}/${to.model}`,
          ...(!sameRef(target, to) && { rewrittenTo: `${target.endpoint}/${target.model}` }),
          scope: tenantId ? 'tenant' : 'platform',
          ...tenantCounts,
          ...(except && {
            exceptGroups: except.groupIds.join(','),
            exceptedUsers: except.userIds.length,
            redirect: false,
          }),
          ...(change && {
            successorConfigs: change.configs,
            successorAssigned: change.assignment,
          }),
        },
      };
    };
    const tenants = new Map(Object.entries(byTenant).filter(([id]) => id !== ''));
    for (const id of Object.keys(enabled)) {
      if (id && !tenants.has(id)) tenants.set(id, emptyMigrationCounts());
    }
    if (tenantId) tenants.set(tenantId, byTenant[tenantId] ?? emptyMigrationCounts());
    for (const [id, tenantCounts] of tenants) {
      await input.audit(event(tenantCounts, id));
    }
    if (!tenantId) await input.audit(event(counts, undefined));

    return {
      ok: true,
      migration: {
        id: migrationId,
        scope: tenantId ? 'tenant' : 'platform',
        ...(redirect?.tenantIds && { tenantIds: redirect.tenantIds }),
        from,
        to,
        rewrittenTo: groups[0].to,
        at: at.toISOString(),
        counts,
        ...(!tenantId && { successorEnabled: enabled }),
        ...(except && { exceptGroups: except.groupIds }),
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

  async function tenantScope(tenantId: string, exceptGroups?: string[]): Promise<ScopeOutcome> {
    if (!exceptGroups?.length) return { ok: true, scope: { tenantId } };
    const groupIds = [...new Set(exceptGroups)];
    const members = await store.findGroupMemberUsers(tenantId, groupIds);
    if (!members.ok) return members;
    return { ok: true, scope: { tenantId, except: { groupIds, userIds: members.userIds } } };
  }

  return {
    run,
    hasRedirect,
    tenantScope,
    preview: (scope, from) =>
      store.previewModelMigration(from, agentProvidersFor(from.endpoint), audienceOf(scope)),
    usage: (scope, models) =>
      store.countModelUsage(
        models.map((ref) => ({ ...ref, agentProviders: agentProvidersFor(ref.endpoint) })),
        audienceOf(scope),
      ),
  };
}
