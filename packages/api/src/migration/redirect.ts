import { PLATFORM_REDIRECT_SCOPE } from '@librechat/data-schemas';
import {
  EModelEndpoint,
  isAgentsEndpoint,
  normalizeEndpointName,
  resolveModelCatalogKey,
} from 'librechat-data-provider';
import type { AppConfig, ModelRedirect, ModelRef } from '@librechat/data-schemas';

/**
 * Runtime model redirects (fork-only, see `methods/modelMigration.ts` in data-schemas): a request
 * that still names a migrated model (a stale client, an import, a cached model spec, an agent
 * saved after the rewrite) runs on the successor instead.
 *
 * At each step the tenant's own redirect wins over the operator's, and an operator redirect for
 * listed tenants over one for every tenant. Chains (A→B, B→C) are followed; a step that would
 * return to a model already passed ends the chain there, so a cycle cannot loop.
 */

/** Longest chain followed; well beyond any real succession of models. */
const MAX_HOPS = 16;

const refKey = (ref: ModelRef) => `${ref.endpoint}\u0000${ref.model}`;

interface RedirectIndex {
  /** Old model → tenant id → the tenant's redirect. */
  own: Map<string, Map<string, ModelRedirect>>;
  /** Old model → tenant id → the operator's redirect for listed tenants (latest first). */
  listed: Map<string, Map<string, ModelRedirect>>;
  /** Old model → the operator's redirect for every tenant. */
  all: Map<string, ModelRedirect>;
}

const indexes = new WeakMap<readonly ModelRedirect[], RedirectIndex>();

function latest(a: ModelRedirect | undefined, b: ModelRedirect): ModelRedirect {
  if (!a) return b;
  return (b.updatedAt?.getTime() ?? 0) > (a.updatedAt?.getTime() ?? 0) ? b : a;
}

/** Built once per loaded snapshot of redirects. */
function indexOf(redirects: readonly ModelRedirect[]): RedirectIndex {
  const cached = indexes.get(redirects);
  if (cached) return cached;
  const index: RedirectIndex = { own: new Map(), listed: new Map(), all: new Map() };
  const put = (
    map: Map<string, Map<string, ModelRedirect>>,
    key: string,
    tenantId: string,
    r: ModelRedirect,
  ) => {
    const byTenant = map.get(key) ?? new Map<string, ModelRedirect>();
    byTenant.set(tenantId, latest(byTenant.get(tenantId), r));
    map.set(key, byTenant);
  };
  for (const redirect of redirects) {
    const key = refKey(redirect.from);
    if (redirect.scope !== PLATFORM_REDIRECT_SCOPE) {
      put(index.own, key, redirect.scope, redirect);
    } else if (redirect.tenantIds) {
      redirect.tenantIds.forEach((tenantId) => put(index.listed, key, tenantId, redirect));
    } else {
      index.all.set(key, latest(index.all.get(key), redirect));
    }
  }
  indexes.set(redirects, index);
  return index;
}

/** The redirect that applies to `ref` for the tenant, one step only. */
export function findRedirect(
  redirects: readonly ModelRedirect[],
  tenantId: string | null | undefined,
  ref: ModelRef,
): ModelRedirect | undefined {
  if (redirects.length === 0) return undefined;
  const index = indexOf(redirects);
  const key = refKey(ref);
  if (tenantId) {
    const own = index.own.get(key)?.get(tenantId) ?? index.listed.get(key)?.get(tenantId);
    if (own) return own;
  }
  return index.all.get(key);
}

export interface RedirectResult {
  to: ModelRef;
  /** The redirects followed, in order. */
  applied: ModelRedirect[];
}

/** Where `ref` runs for the tenant, following chains; null when no redirect applies. */
export function resolveModelRedirect(
  redirects: readonly ModelRedirect[],
  tenantId: string | null | undefined,
  ref: ModelRef,
): RedirectResult | null {
  if (redirects.length === 0 || !ref.endpoint || !ref.model) return null;
  const seen = new Set([refKey(ref)]);
  const applied: ModelRedirect[] = [];
  let current = ref;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next = findRedirect(redirects, tenantId, current);
    if (!next || seen.has(refKey(next.to))) break;
    seen.add(refKey(next.to));
    applied.push(next);
    current = next.to;
  }
  return applied.length > 0 ? { to: { ...current }, applied } : null;
}

/** The endpoint an agent's stored `provider` runs on, as the model validation reads it. */
export function agentEndpoint(provider: string): string {
  return resolveModelCatalogKey(provider);
}

/** Every stored agent `provider` that runs on `endpoint`. */
export function agentProvidersFor(endpoint: string): string[] {
  const providers = new Set([endpoint]);
  if (endpoint === EModelEndpoint.google) providers.add('vertexai');
  if (normalizeEndpointName(endpoint) === 'ollama') {
    providers.add('ollama');
    providers.add('Ollama');
  }
  return [...providers];
}

const knownEndpoints = new Set<string>(Object.values(EModelEndpoint));

/** `endpointType` stored with an endpoint: `custom` for a custom endpoint, none for a built-in one. */
export function endpointTypeFor(endpoint: string): string | undefined {
  return knownEndpoints.has(endpoint) ? undefined : EModelEndpoint.custom;
}

export interface ModelRedirector {
  resolve(tenantId: string | null | undefined, ref: ModelRef): RedirectResult | null;
  /**
   * Moves an agent about to run (its `provider` and `model`) to its successor; true when it
   * moved. A platform agent's copy is left alone: it runs as its definition says.
   */
  redirectAgent(
    agent: { provider?: string; model?: string | null; platformAgentId?: string },
    tenantId: string | null | undefined,
  ): boolean;
  /** Moves a chat request's `endpoint`/`model` (not the agents endpoint); true when it moved. */
  redirectRequestBody(
    body: { endpoint?: string; endpointType?: string; model?: string | null } | undefined,
    tenantId: string | null | undefined,
  ): boolean;
  /** The config with each model spec's preset moved; the same object when none moves. */
  redirectModelSpecs(appConfig: AppConfig, tenantId: string | null | undefined): AppConfig;
}

export function createModelRedirector(deps: {
  /** The in-memory copy of every redirect (`getModelRedirects` of data-schemas). */
  getModelRedirects(): readonly ModelRedirect[];
}): ModelRedirector {
  const resolve = (tenantId: string | null | undefined, ref: ModelRef) =>
    resolveModelRedirect(deps.getModelRedirects(), tenantId, ref);

  return {
    resolve,

    redirectAgent(agent, tenantId) {
      if (agent.platformAgentId || !agent.provider || !agent.model) return false;
      const result = resolve(tenantId, {
        endpoint: agentEndpoint(agent.provider),
        model: agent.model,
      });
      if (!result) return false;
      agent.provider = result.to.endpoint;
      agent.model = result.to.model;
      return true;
    },

    redirectRequestBody(body, tenantId) {
      if (!body?.endpoint || !body.model || isAgentsEndpoint(body.endpoint)) return false;
      const result = resolve(tenantId, { endpoint: body.endpoint, model: body.model });
      if (!result) return false;
      if (result.to.endpoint !== body.endpoint) {
        body.endpointType = endpointTypeFor(result.to.endpoint);
        if (body.endpointType === undefined) delete body.endpointType;
      }
      body.endpoint = result.to.endpoint;
      body.model = result.to.model;
      return true;
    },

    redirectModelSpecs(appConfig, tenantId) {
      const list = appConfig.modelSpecs?.list;
      if (!list?.length || deps.getModelRedirects().length === 0) return appConfig;
      let changed = false;
      const moved = list.map((spec) => {
        const { endpoint, model } = spec.preset ?? {};
        if (!endpoint || !model || isAgentsEndpoint(endpoint)) return spec;
        const result = resolve(tenantId, { endpoint, model });
        if (!result) return spec;
        changed = true;
        const preset = { ...spec.preset, endpoint: result.to.endpoint, model: result.to.model };
        if (result.to.endpoint !== endpoint) {
          const endpointType = endpointTypeFor(result.to.endpoint);
          if (endpointType) preset.endpointType = endpointType as EModelEndpoint;
          else delete preset.endpointType;
        }
        return { ...spec, preset };
      });
      if (!changed) return appConfig;
      return { ...appConfig, modelSpecs: { ...appConfig.modelSpecs!, list: moved } };
    },
  };
}

/**
 * A chat route middleware that moves the request's `endpoint`/`model` to its successor before the
 * endpoint options are built and the model is validated.
 */
export function createRequestRedirect(redirector: Pick<ModelRedirector, 'redirectRequestBody'>): (
  req: {
    body?: Parameters<ModelRedirector['redirectRequestBody']>[0];
    user?: { tenantId?: string };
  },
  res: unknown,
  next: () => void,
) => void {
  return (req, _res, next) => {
    redirector.redirectRequestBody(req.body, req.user?.tenantId);
    next();
  };
}

/**
 * `validateAgentModel` with the agent moved to its successor first, for every agent of a run
 * (the primary agent, handoff targets, subagents and an added conversation's agent).
 */
export function withAgentRedirect<
  P extends {
    req: { user?: { tenantId?: string } };
    agent: Parameters<ModelRedirector['redirectAgent']>[0];
  },
  R,
>(
  validate: (params: P) => Promise<R>,
  redirector: Pick<ModelRedirector, 'redirectAgent'>,
): (params: P) => Promise<R> {
  return (params: P): Promise<R> => {
    redirector.redirectAgent(params.agent, params.req.user?.tenantId);
    return validate(params);
  };
}
