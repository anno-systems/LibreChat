import { logger } from '@librechat/data-schemas';
import { normalizeEndpointName } from 'librechat-data-provider';
import type {
  AppConfig,
  PlatformAgent,
  PlatformAgentMethods,
  PlatformProvider,
} from '@librechat/data-schemas';
import type { TEndpoint, TModelsConfig } from 'librechat-data-provider';
import { getSafeErrorMetadata } from '~/utils/errors';
import { providerEndpoint } from './catalog';

/**
 * Platform agents (fork-only): agents the platform operator defines once for every tenant or for
 * listed ones, such as the support agent. Each targeted tenant holds a copy, a normal agent of
 * the tenant (`methods/platformAgent.ts` in data-schemas), so the chat, the agent list, sharing
 * and usage need nothing new. This module keeps the copies in step with the definitions and
 * gives a run of a copy its provider from the platform catalog.
 *
 * Copies are written when the operator saves or deletes a definition and when a tenant admin
 * switches one, in every tenant that has or should have one. A tenant created later gets its
 * copies lazily, the first time its agents are listed (`ensureTenant`).
 */

/** How long definitions, providers and a tenant's sync are reused on this replica. */
const DEFAULT_TTL_MS = 30_000;
/** Copies written at once when a definition changes. */
const BATCH = 10;

export interface PlatformAgentServiceDeps {
  store: PlatformAgentMethods;
  /** Platform providers by name, keys encrypted. */
  findPlatformProviders(names: string[]): Promise<PlatformProvider[]>;
  decrypt(value: string): string;
  ttlMs?: number;
  now?: () => number;
}

/** The parts of an agent a run needs to tell whether it is a platform agent's copy. */
export interface PlatformAgentRef {
  platformAgentId?: string;
  provider?: string;
  model?: string | null;
}

export interface PlatformAgentRun {
  appConfig: AppConfig | undefined;
  modelsConfig: TModelsConfig | undefined;
}

export interface PlatformAgentSyncResult {
  written: number;
  removed: number;
}

export interface PlatformAgentService {
  /** Every definition, cached briefly. */
  list(): Promise<PlatformAgent[]>;
  /** Writes or removes the copies of one definition in every tenant that has or should have one. */
  sync(platformAgentId: string): Promise<PlatformAgentSyncResult>;
  /**
   * Brings one tenant's copies in step with the definitions, at most once per TTL. Best effort:
   * a failure is logged and retried on the next call, never thrown, so the agent list it runs
   * before still answers.
   */
  ensureTenant(tenantId: string | null | undefined): Promise<void>;
  /**
   * The config a run of `agent` uses. For a tenant's current copy of a platform agent, the
   * catalog provider it names is added as a custom endpoint of this run only, and its model to
   * the models the run validates against, so the agent works without the tenant being assigned
   * the provider. The tenant's endpoint and model lists stay as they are. Any other agent, or a
   * copy that no longer matches its definition, gets the configs unchanged.
   */
  prepareRun(params: {
    agent: PlatformAgentRef;
    tenantId: string | null | undefined;
    appConfig: AppConfig | undefined;
    modelsConfig: TModelsConfig | undefined;
  }): Promise<PlatformAgentRun>;
  /** Drops the cached definitions, providers and tenant syncs of this replica. */
  invalidate(): void;
}

/** Whether a definition is meant for the tenant. */
export function targetsTenant(agent: Pick<PlatformAgent, 'tenants'>, tenantId: string): boolean {
  return agent.tenants === 'all' || agent.tenants.includes(tenantId);
}

/** Whether the tenant should hold a copy: targeted, and not switched off by its admins. */
export function isActiveFor(
  agent: Pick<PlatformAgent, 'tenants' | 'disabledTenants'>,
  tenantId: string,
): boolean {
  return targetsTenant(agent, tenantId) && !agent.disabledTenants.includes(tenantId);
}

/**
 * The config with `endpoint` among its custom endpoints. A config that already has an endpoint
 * of that name (the tenant is assigned the provider) is returned as it is.
 */
export function withRunEndpoint(
  appConfig: AppConfig | undefined,
  endpoint: TEndpoint,
): AppConfig | undefined {
  if (!appConfig) return appConfig;
  const custom = appConfig.endpoints?.custom ?? [];
  const name = normalizeEndpointName(endpoint.name);
  if (custom.some((e) => normalizeEndpointName(e.name) === name)) return appConfig;
  return { ...appConfig, endpoints: { ...appConfig.endpoints, custom: [...custom, endpoint] } };
}

function cache<T>(ttlMs: number, now: () => number) {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const value = load();
      entries.set(key, { at: now(), value });
      // A failed load is not reused; the next call tries again.
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      return value;
    },
    clear() {
      entries.clear();
    },
  };
}

async function inBatches(steps: Array<() => Promise<unknown>>): Promise<void> {
  for (let i = 0; i < steps.length; i += BATCH) {
    await Promise.all(steps.slice(i, i + BATCH).map((step) => step()));
  }
}

export function createPlatformAgentService(deps: PlatformAgentServiceDeps): PlatformAgentService {
  const { store, decrypt } = deps;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? Date.now;
  const definitions = cache<PlatformAgent[]>(ttlMs, now);
  const providers = cache<PlatformProvider | undefined>(ttlMs, now);
  const tenants = cache<void>(ttlMs, now);

  const list = () => definitions.get('all', () => store.listPlatformAgents());
  const providerOf = (name: string) =>
    providers.get(name, async () => (await deps.findPlatformProviders([name]))[0]);

  function invalidate() {
    definitions.clear();
    providers.clear();
    tenants.clear();
  }

  async function sync(platformAgentId: string): Promise<PlatformAgentSyncResult> {
    const [agent, copies] = await Promise.all([
      store.getPlatformAgent(platformAgentId),
      store.listPlatformAgentCopies(platformAgentId),
    ]);
    const have = copies.map((copy) => copy.tenantId);
    const listed = agent && agent.tenants !== 'all' ? agent.tenants : [];
    const keep = [...new Set([...have, ...listed])].filter(
      (tenantId) => agent != null && isActiveFor(agent, tenantId),
    );
    const drop = have.filter((tenantId) => !keep.includes(tenantId));
    try {
      await inBatches([
        ...keep.map((tenantId) => () => store.writePlatformAgentCopy(tenantId, agent!)),
        ...drop.map((tenantId) => () => store.removePlatformAgentCopy(tenantId, platformAgentId)),
      ]);
    } finally {
      invalidate();
    }
    return { written: keep.length, removed: drop.length };
  }

  async function syncTenant(tenantId: string): Promise<void> {
    /** Read fresh, not from the cache: a stale definition on this replica would bring back a
     * copy the tenant's admin just switched off on another one. */
    const agents = await store.listPlatformAgents();
    const copies = agents.length > 0 ? await store.listTenantPlatformAgentCopies(tenantId) : [];
    const byId = new Map(agents.map((agent) => [agent.platformAgentId, agent]));
    const copyOf = new Map(copies.map((copy) => [copy.platformAgentId, copy]));
    const writes = agents.filter((agent) => {
      if (!isActiveFor(agent, tenantId)) return false;
      const copy = copyOf.get(agent.platformAgentId);
      return (
        !copy ||
        (agent.updatedAt != null && copy.updatedAt != null && copy.updatedAt < agent.updatedAt)
      );
    });
    const removals = copies.filter((copy) => {
      const agent = byId.get(copy.platformAgentId);
      return !agent || !isActiveFor(agent, tenantId);
    });
    await inBatches([
      ...writes.map((agent) => () => store.writePlatformAgentCopy(tenantId, agent)),
      ...removals.map(
        (copy) => () => store.removePlatformAgentCopy(tenantId, copy.platformAgentId),
      ),
    ]);
  }

  async function ensureTenant(tenantId: string | null | undefined): Promise<void> {
    if (!tenantId) return;
    try {
      await tenants.get(tenantId, () => syncTenant(tenantId));
    } catch (error) {
      logger.warn('[platformAgents] tenant sync failed', {
        tenantId,
        ...getSafeErrorMetadata(error),
      });
    }
  }

  async function prepareRun({
    agent,
    tenantId,
    appConfig,
    modelsConfig,
  }: Parameters<PlatformAgentService['prepareRun']>[0]): Promise<PlatformAgentRun> {
    const unchanged = { appConfig, modelsConfig };
    if (!agent.platformAgentId || !tenantId) return unchanged;
    const definition = (await list()).find((d) => d.platformAgentId === agent.platformAgentId);
    if (
      !definition ||
      !isActiveFor(definition, tenantId) ||
      definition.provider !== agent.provider ||
      definition.model !== agent.model
    ) {
      return unchanged;
    }
    const provider = await providerOf(definition.provider);
    if (!provider || !provider.models.includes(definition.model)) return unchanged;
    const endpoint = providerEndpoint(tenantId, provider, [definition.model], decrypt);
    const validated = modelsConfig?.[definition.provider] ?? [];
    return {
      appConfig: withRunEndpoint(appConfig, endpoint),
      modelsConfig: {
        ...modelsConfig,
        [definition.provider]: validated.includes(definition.model)
          ? validated
          : [...validated, definition.model],
      },
    };
  }

  return { list, sync, ensureTenant, prepareRun, invalidate };
}
