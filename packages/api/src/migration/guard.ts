import { z } from 'zod';
import type { AppConfig, ModelRef, PlatformAgent, PlatformProvider } from '@librechat/data-schemas';
import type { Request } from 'express';
import type { MigrationAuditEvent, MigrationScope, ModelMigrationService } from './service';
import { modelRefSchema } from './handlers';

/**
 * The operator's catalog writes may not take a model away from what still uses it (fork-only).
 * A provider update that drops models, or a tenant assignment that drops models, is refused with
 * 409 `model_in_use` while agents or conversations use a dropped model, unless a redirect for it
 * exists or the same call names its successor (`successors`). Successors are migrated before
 * the write, so no request finds the model gone and its users not yet moved.
 */

export type Successor = { from: ModelRef; to: ModelRef };

export const successorsSchema: z.ZodOptional<z.ZodType<Successor[]>> = z
  .array(z.object({ from: modelRefSchema, to: modelRefSchema }).strict())
  .max(100)
  .optional();

export type RemovalCheck =
  | { ok: true }
  | {
      ok: false;
      status: 400 | 409;
      body:
        | { error: 'invalid_successor' }
        | { error: 'model_used_by_platform_agents'; agents: string[] }
        | {
            error: 'model_in_use';
            models: Array<ModelRef & { agents: number; conversations: number }>;
          };
    };

export interface ModelRemovalGuardDeps {
  service: ModelMigrationService;
  listPlatformAgents(): Promise<Pick<PlatformAgent, 'platformAgentId' | 'provider' | 'model'>[]>;
  audit(req: Request, event: MigrationAuditEvent): Promise<void>;
  /** The operator the admin app names, recorded on the redirect. */
  operatorId(req: Request): string;
}

export interface ModelRemovalGuard {
  /**
   * Checks dropping `removed` for `scope`. `isTarget` says whether a successor may be named
   * (a model the scope can run once the write is saved).
   */
  check(params: {
    removed: ModelRef[];
    scope: MigrationScope;
    successors: Successor[];
    isTarget(ref: ModelRef): Promise<boolean>;
  }): Promise<RemovalCheck>;
  /** Saves the successors as redirects and migrates what uses the dropped models. */
  migrate(req: Request, scope: MigrationScope, successors: Successor[]): Promise<boolean>;
}

const key = (ref: ModelRef) => `${ref.endpoint}\u0000${ref.model}`;

export function createModelRemovalGuard(deps: ModelRemovalGuardDeps): ModelRemovalGuard {
  return {
    async check({ removed, scope, successors, isTarget }) {
      const dropped = new Set(removed.map(key));
      const named = new Set(successors.map((s) => key(s.from)));
      if (named.size !== successors.length || successors.some((s) => !dropped.has(key(s.from)))) {
        return { ok: false, status: 400, body: { error: 'invalid_successor' } };
      }
      for (const { to } of successors) {
        if (dropped.has(key(to)) || !(await isTarget(to))) {
          return { ok: false, status: 400, body: { error: 'invalid_successor' } };
        }
      }
      if (removed.length === 0) return { ok: true };

      const agents = (await deps.listPlatformAgents())
        .filter((a) => dropped.has(key({ endpoint: a.provider, model: a.model })))
        .map((a) => a.platformAgentId);
      if (agents.length > 0) {
        return { ok: false, status: 409, body: { error: 'model_used_by_platform_agents', agents } };
      }

      const open = removed.filter(
        (ref) => !named.has(key(ref)) && !deps.service.hasRedirect(scope, ref),
      );
      if (open.length === 0) return { ok: true };
      const usage = await deps.service.usage(scope, open);
      const inUse = usage.filter((u) => u.agents > 0 || u.conversations > 0);
      if (inUse.length === 0) return { ok: true };
      return { ok: false, status: 409, body: { error: 'model_in_use', models: inUse } };
    },

    async migrate(req, scope, successors) {
      for (const { from, to } of successors) {
        const outcome = await deps.service.run({
          scope,
          from,
          to,
          createdBy: deps.operatorId(req),
          audit: (event) => deps.audit(req, event),
        });
        if (!outcome.ok) return false;
      }
      return true;
    },
  };
}

/** Model names of a configured model list (`models.default`). */
function listedModels(models: { default?: readonly unknown[] } | undefined): string[] {
  return (models?.default ?? []).map((m) =>
    typeof m === 'string' ? m : String((m as { name?: string })?.name ?? ''),
  );
}

/**
 * Whether `ref` is a model of the operator's catalog: a librechat.yaml custom endpoint's model
 * or a platform provider's.
 */
export function createCatalogModelCheck(deps: {
  getBaseConfig(): Promise<AppConfig>;
  findPlatformProviders(names: string[]): Promise<Pick<PlatformProvider, 'name' | 'models'>[]>;
}): (ref: ModelRef) => Promise<boolean> {
  return async (ref) => {
    const yaml = ((await deps.getBaseConfig()).config?.endpoints?.custom ?? []).find(
      (e) => e.name === ref.endpoint,
    );
    if (yaml) return listedModels(yaml.models).includes(ref.model);
    const [provider] = await deps.findPlatformProviders([ref.endpoint]);
    return provider?.models.some((model) => model.id === ref.model) ?? false;
  };
}
