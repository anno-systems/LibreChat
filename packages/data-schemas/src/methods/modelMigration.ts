import crypto from 'node:crypto';
import { Schema } from 'mongoose';
import type { FilterQuery, Model } from 'mongoose';
import type { ModelMigrationNotice } from '~/schema/modelMigration';
import { runAsSystem, tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';

/**
 * Model migrations (fork-only): a mapping (endpoint, model) → (endpoint, model) that is kept as
 * a runtime redirect and, once per run, rewrites what is stored with the old model: agents,
 * conversations, presets, model specs in config documents and model favorites. Messages keep
 * the model they were written with.
 *
 * Redirects live platform-wide, without a tenant, like platform prices and banners: `scope` is
 * `platform` (the operator's, for every tenant or for `tenantIds`) or the id of the tenant whose
 * admin made it. They are read on every chat request, so the documents are held in memory and
 * reloaded at most every `refreshMs`; a write through these methods updates the copy at once.
 */

export const PLATFORM_REDIRECT_SCOPE = 'platform';

export interface ModelRef {
  endpoint: string;
  model: string;
}

/** What a migration rewrote (or a preview would rewrite), per kind. */
export interface MigrationCounts {
  agents: number;
  /** Conversations on the old model, moved to the new one. */
  conversations: number;
  /** Conversations with a migrated agent; they get the notice only. */
  agentConversations: number;
  presets: number;
  /** Model specs in config documents (tenant, group, role or user). */
  modelSpecs: number;
  /** Model favorites of users. */
  favorites: number;
}

export interface ModelRedirect {
  /** Also the migration id written into notices. */
  redirectId: string;
  /** `platform` or the owning tenant's id. */
  scope: string;
  /** Platform scope only: the tenants it applies to; absent means every tenant. */
  tenantIds?: string[];
  from: ModelRef;
  to: ModelRef;
  /** Who made it, as recorded in the audit log. */
  createdBy?: string;
  lastRun?: { at: Date; counts: MigrationCounts };
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ModelRedirectInput {
  scope: string;
  tenantIds?: string[];
  from: ModelRef;
  to: ModelRef;
  createdBy?: string;
}

/** Whose documents a query or rewrite reaches. */
export type MigrationAudience = { tenantId: string } | { tenantIds: string[] } | { all: true };

/** A model whose use is counted; `agentProviders` are the agent `provider` values that mean the endpoint. */
export interface UsageQuery extends ModelRef {
  agentProviders: string[];
}

export interface ModelUsage extends ModelRef {
  agents: number;
  conversations: number;
}

export interface MigrateModelInput {
  migrationId: string;
  from: ModelRef;
  to: ModelRef;
  /** Agent `provider` values that mean `from.endpoint`. */
  agentProviders: string[];
  /** `endpointType` stored with `to.endpoint` when the endpoint changes; absent unsets it. */
  toEndpointType?: string;
  audience: MigrationAudience;
  at?: Date;
  batchSize?: number;
}

export interface MigrateModelResult {
  counts: MigrationCounts;
  /** Counts per tenant (`''` for documents without a tenant), for each tenant's audit log. */
  byTenant: Record<string, MigrationCounts>;
  /** Users whose favorites changed: their cached auth documents are stale. */
  userIds: string[];
  /** Tenants whose config documents changed: their merged configs are stale. */
  configTenants: string[];
}

export interface ModelMigrationMethods {
  listModelRedirects(filter?: { scope?: string }): Promise<ModelRedirect[]>;
  /** Creates the redirect, or updates the one with the same scope, audience and old model. */
  upsertModelRedirect(input: ModelRedirectInput): Promise<ModelRedirect>;
  /** False when `scope` has no redirect with the id. */
  deleteModelRedirect(scope: string, redirectId: string): Promise<boolean>;
  recordModelMigrationRun(redirectId: string, counts: MigrationCounts, at?: Date): Promise<void>;
  /** Reloads the in-memory copy. */
  loadModelRedirects(): Promise<void>;
  /** Every redirect, from the in-memory copy; starts a reload when it is stale. */
  getModelRedirects(): ModelRedirect[];
  countModelUsage(models: UsageQuery[], audience: MigrationAudience): Promise<ModelUsage[]>;
  previewModelMigration(
    from: ModelRef,
    agentProviders: string[],
    audience: MigrationAudience,
  ): Promise<MigrationCounts>;
  /** Rewrites the stored documents in batches; running it again changes nothing. */
  migrateModelUsage(input: MigrateModelInput): Promise<MigrateModelResult>;
  /** The conversation's unseen notice, for its owner. */
  getConversationModelMigration(
    user: string,
    conversationId: string,
  ): Promise<ModelMigrationNotice | null>;
  /** False when the conversation had no notice. */
  clearConversationModelMigration(user: string, conversationId: string): Promise<boolean>;
  /** False when the agent had no notice. */
  clearAgentModelMigration(agentId: string): Promise<boolean>;
}

const modelRefSchema = new Schema<ModelRef>(
  {
    endpoint: { type: String, required: true, maxlength: 128 },
    model: { type: String, required: true, maxlength: 256 },
  },
  { _id: false },
);

const countsDefinition = {
  agents: Number,
  conversations: Number,
  agentConversations: Number,
  presets: Number,
  modelSpecs: Number,
  favorites: Number,
};

interface StoredRedirect extends ModelRedirect {
  key: string;
}

const modelRedirectSchema = new Schema<StoredRedirect>(
  {
    redirectId: { type: String, required: true, unique: true },
    key: { type: String, required: true, unique: true },
    scope: { type: String, required: true, index: true },
    tenantIds: { type: [String], default: undefined },
    from: { type: modelRefSchema, required: true },
    to: { type: modelRefSchema, required: true },
    createdBy: { type: String },
    lastRun: {
      type: new Schema({ at: Date, counts: countsDefinition }, { _id: false }),
      default: undefined,
    },
  },
  { timestamps: true },
);

const DEFAULT_BATCH = 500;

export function emptyCounts(): MigrationCounts {
  return {
    agents: 0,
    conversations: 0,
    agentConversations: 0,
    presets: 0,
    modelSpecs: 0,
    favorites: 0,
  };
}

/** One redirect per scope, audience and old model. */
function redirectKey(input: ModelRedirectInput): string {
  const audience = input.tenantIds ? [...new Set(input.tenantIds)].sort().join(',') : '*';
  return [input.scope, audience, input.from.endpoint, input.from.model].join('\u0000');
}

function toRedirect(doc: StoredRedirect): ModelRedirect {
  return {
    redirectId: doc.redirectId,
    scope: doc.scope,
    ...(doc.tenantIds && { tenantIds: [...doc.tenantIds] }),
    from: { endpoint: doc.from.endpoint, model: doc.from.model },
    to: { endpoint: doc.to.endpoint, model: doc.to.model },
    ...(doc.createdBy && { createdBy: doc.createdBy }),
    ...(doc.lastRun?.at && {
      lastRun: { at: doc.lastRun.at, counts: { ...emptyCounts(), ...doc.lastRun.counts } },
    }),
    ...(doc.createdAt && { createdAt: doc.createdAt }),
    ...(doc.updatedAt && { updatedAt: doc.updatedAt }),
  };
}

function audienceFilter(audience: MigrationAudience): Record<string, unknown> {
  if ('tenantId' in audience) return { tenantId: audience.tenantId };
  if ('tenantIds' in audience) return { tenantId: { $in: audience.tenantIds } };
  return {};
}

interface Row {
  _id: unknown;
  tenantId?: string;
  id?: string;
}

export function createModelMigrationMethods(
  mongoose: typeof import('mongoose'),
  options: { refreshMs?: number; now?: () => number } = {},
): ModelMigrationMethods {
  const Redirect: Model<StoredRedirect> =
    mongoose.models.ModelRedirect ||
    mongoose.model<StoredRedirect>('ModelRedirect', modelRedirectSchema);
  const refreshMs = options.refreshMs ?? 30_000;
  const now = options.now ?? Date.now;

  let redirects: ModelRedirect[] = [];
  let loadedAt = -Infinity;
  let loading: Promise<void> | null = null;

  const model = (name: string): Model<Record<string, unknown>> | undefined =>
    mongoose.models[name] as Model<Record<string, unknown>> | undefined;

  /** Tenant migrations run in their tenant; platform ones across tenants. */
  function inAudience<T>(audience: MigrationAudience, fn: () => Promise<T>): Promise<T> {
    if ('tenantId' in audience) {
      if (!audience.tenantId || audience.tenantId === SYSTEM_TENANT_ID) {
        throw new Error('A tenant migration needs a tenant id');
      }
      return tenantStorage.run({ ...tenantStorage.getStore(), tenantId: audience.tenantId }, fn);
    }
    return runAsSystem(fn);
  }

  async function loadModelRedirects(): Promise<void> {
    const docs = await Redirect.find({}).sort({ updatedAt: -1 }).lean<StoredRedirect[]>();
    redirects = docs.map(toRedirect);
    loadedAt = now();
  }

  function getModelRedirects(): ModelRedirect[] {
    if (!loading && now() - loadedAt >= refreshMs) {
      loading = loadModelRedirects()
        .catch(() => {
          // Keep the last copy; the next stale read tries again.
          loadedAt = now();
        })
        .finally(() => {
          loading = null;
        });
    }
    return redirects;
  }

  const agentMatch = (from: ModelRef, agentProviders: string[], audience: MigrationAudience) => ({
    ...audienceFilter(audience),
    provider: { $in: agentProviders.length > 0 ? agentProviders : [from.endpoint] },
    model: from.model,
    /* A platform agent's copy follows its definition, which only the operator changes. */
    platformAgentId: { $exists: false },
  });
  const convoMatch = (from: ModelRef, audience: MigrationAudience) => ({
    ...audienceFilter(audience),
    endpoint: from.endpoint,
    model: from.model,
  });
  const specMatch = (from: ModelRef, audience: MigrationAudience) => ({
    ...audienceFilter(audience),
    'overrides.modelSpecs.list': {
      $elemMatch: { 'preset.endpoint': from.endpoint, 'preset.model': from.model },
    },
  });
  const favoriteMatch = (from: ModelRef, audience: MigrationAudience) => ({
    ...audienceFilter(audience),
    favorites: { $elemMatch: { endpoint: from.endpoint, model: from.model } },
  });

  async function count(name: string, filter: Record<string, unknown>): Promise<number> {
    const Target = model(name);
    return Target ? Target.countDocuments(filter as FilterQuery<Record<string, unknown>>) : 0;
  }

  /**
   * Updates the documents matching `match` in batches of `_id`s. Each batch is updated with the
   * match repeated, so a document changed meanwhile is skipped, and the cursor moves on by `_id`,
   * so a document the update could not change is not read again.
   */
  async function rewrite(
    name: string,
    match: Record<string, unknown>,
    update: Record<string, unknown>,
    batchSize: number,
    onBatch: (rows: Row[]) => Promise<void> | void,
    updateOptions: Record<string, unknown> = {},
  ): Promise<void> {
    const Target = model(name);
    if (!Target) return;
    let after: unknown;
    for (;;) {
      const filter = { ...match, ...(after != null && { _id: { $gt: after } }) };
      const rows = await Target.find(filter as FilterQuery<Record<string, unknown>>)
        .sort({ _id: 1 })
        .limit(batchSize)
        .select('_id tenantId id')
        .lean<Row[]>();
      if (rows.length === 0) return;
      after = rows[rows.length - 1]._id;
      await Target.updateMany(
        { ...match, _id: { $in: rows.map((row) => row._id) } } as FilterQuery<
          Record<string, unknown>
        >,
        update,
        { timestamps: false, ...updateOptions },
      );
      await onBatch(rows);
      if (rows.length < batchSize) return;
    }
  }

  async function migrateModelUsage(input: MigrateModelInput): Promise<MigrateModelResult> {
    const { from, to, audience, migrationId } = input;
    const batchSize = input.batchSize ?? DEFAULT_BATCH;
    const at = input.at ?? new Date();
    const notice: ModelMigrationNotice = { id: migrationId, from, to, at };
    const endpointChanged = from.endpoint !== to.endpoint;
    const endpointType: { set: Record<string, string>; unset: Record<string, 1> } = {
      set: {},
      unset: {},
    };
    if (endpointChanged && input.toEndpointType) {
      endpointType.set.endpointType = input.toEndpointType;
    } else if (endpointChanged) {
      endpointType.unset.endpointType = 1;
    }
    const counts = emptyCounts();
    const byTenant: Record<string, MigrationCounts> = {};
    const userIds = new Set<string>();
    const configTenants = new Set<string>();
    const tally = (kind: keyof MigrationCounts, rows: Row[]) => {
      counts[kind] += rows.length;
      for (const row of rows) {
        const tenant = row.tenantId ?? '';
        byTenant[tenant] ??= emptyCounts();
        byTenant[tenant][kind] += 1;
      }
    };
    const withUnset = (set: Record<string, unknown>, unset: Record<string, unknown>) => ({
      $set: set,
      ...(Object.keys(unset).length > 0 && { $unset: unset }),
    });

    await inAudience(audience, async () => {
      await rewrite(
        'Agent',
        agentMatch(from, input.agentProviders, audience),
        { $set: { provider: to.endpoint, model: to.model, modelMigration: notice } },
        batchSize,
        async (rows) => {
          tally('agents', rows);
          const ids = rows.map((row) => row.id).filter((id): id is string => Boolean(id));
          if (ids.length === 0) return;
          /* Each tenant's agent ids are its own; match them within the tenant. */
          const byOwner = new Map<string, string[]>();
          for (const row of rows) {
            if (!row.id) continue;
            const tenant = row.tenantId ?? '';
            byOwner.set(tenant, [...(byOwner.get(tenant) ?? []), row.id]);
          }
          for (const [tenant, agentIds] of byOwner) {
            await rewrite(
              'Conversation',
              {
                ...(tenant ? { tenantId: tenant } : { tenantId: { $in: [null, ''] } }),
                agent_id: { $in: agentIds },
                'modelMigration.id': { $ne: migrationId },
              },
              { $set: { modelMigration: notice } },
              batchSize,
              (convos) => tally('agentConversations', convos),
            );
          }
        },
      );
      await rewrite(
        'Conversation',
        convoMatch(from, audience),
        withUnset(
          { endpoint: to.endpoint, model: to.model, modelMigration: notice, ...endpointType.set },
          endpointType.unset,
        ),
        batchSize,
        (rows) => tally('conversations', rows),
      );
      await rewrite(
        'Preset',
        convoMatch(from, audience),
        withUnset(
          { endpoint: to.endpoint, model: to.model, ...endpointType.set },
          endpointType.unset,
        ),
        batchSize,
        (rows) => tally('presets', rows),
      );
      const specSet: Record<string, unknown> = {
        'overrides.modelSpecs.list.$[spec].preset.endpoint': to.endpoint,
        'overrides.modelSpecs.list.$[spec].preset.model': to.model,
      };
      const specUnset: Record<string, unknown> = {};
      if (endpointChanged && input.toEndpointType) {
        specSet['overrides.modelSpecs.list.$[spec].preset.endpointType'] = input.toEndpointType;
      } else if (endpointChanged) {
        specUnset['overrides.modelSpecs.list.$[spec].preset.endpointType'] = 1;
      }
      await rewrite(
        'Config',
        specMatch(from, audience),
        { ...withUnset(specSet, specUnset), $inc: { configVersion: 1 } },
        batchSize,
        (rows) => {
          tally('modelSpecs', rows);
          rows.forEach((row) => configTenants.add(row.tenantId ?? ''));
        },
        {
          timestamps: true,
          arrayFilters: [
            { 'spec.preset.endpoint': from.endpoint, 'spec.preset.model': from.model },
          ],
        },
      );
      await rewrite(
        'User',
        favoriteMatch(from, audience),
        {
          $set: {
            'favorites.$[favorite].endpoint': to.endpoint,
            'favorites.$[favorite].model': to.model,
          },
        },
        batchSize,
        (rows) => {
          tally('favorites', rows);
          rows.forEach((row) => userIds.add(String(row._id)));
        },
        {
          arrayFilters: [{ 'favorite.endpoint': from.endpoint, 'favorite.model': from.model }],
        },
      );
    });

    return { counts, byTenant, userIds: [...userIds], configTenants: [...configTenants] };
  }

  return {
    async listModelRedirects(filter = {}) {
      const docs = await Redirect.find(filter.scope ? { scope: filter.scope } : {})
        .sort({ scope: 1, 'from.endpoint': 1, 'from.model': 1 })
        .lean<StoredRedirect[]>();
      return docs.map(toRedirect);
    },

    async upsertModelRedirect(input) {
      const tenantIds = input.tenantIds ? [...new Set(input.tenantIds)].sort() : undefined;
      const key = redirectKey({ ...input, tenantIds });
      const doc = await Redirect.findOneAndUpdate(
        { key },
        {
          $set: {
            scope: input.scope,
            from: input.from,
            to: input.to,
            ...(tenantIds && { tenantIds }),
            ...(input.createdBy && { createdBy: input.createdBy }),
          },
          $setOnInsert: { key, redirectId: `mm_${crypto.randomUUID()}` },
        },
        { upsert: true, new: true, runValidators: true },
      ).lean<StoredRedirect>();
      const saved = toRedirect(doc as StoredRedirect);
      redirects = [saved, ...redirects.filter((r) => r.redirectId !== saved.redirectId)];
      return saved;
    },

    async deleteModelRedirect(scope, redirectId) {
      const { deletedCount } = await Redirect.deleteOne({ scope, redirectId });
      redirects = redirects.filter((r) => !(r.redirectId === redirectId && r.scope === scope));
      return deletedCount > 0;
    },

    async recordModelMigrationRun(redirectId, counts, at = new Date()) {
      await Redirect.updateOne({ redirectId }, { $set: { lastRun: { at, counts } } });
      redirects = redirects.map((r) =>
        r.redirectId === redirectId ? { ...r, lastRun: { at, counts } } : r,
      );
    },

    loadModelRedirects,
    getModelRedirects,

    async countModelUsage(models, audience) {
      return inAudience(audience, () =>
        Promise.all(
          models.map(async (ref) => {
            const [agents, conversations] = await Promise.all([
              count('Agent', agentMatch(ref, ref.agentProviders, audience)),
              count('Conversation', convoMatch(ref, audience)),
            ]);
            return { endpoint: ref.endpoint, model: ref.model, agents, conversations };
          }),
        ),
      );
    },

    async previewModelMigration(from, agentProviders, audience) {
      return inAudience(audience, async () => {
        const Agent = model('Agent');
        const agents = Agent
          ? await Agent.find(
              agentMatch(from, agentProviders, audience) as FilterQuery<Record<string, unknown>>,
            )
              .select('id tenantId')
              .lean<Row[]>()
          : [];
        const byOwner = new Map<string, string[]>();
        for (const row of agents) {
          if (!row.id) continue;
          const tenant = row.tenantId ?? '';
          byOwner.set(tenant, [...(byOwner.get(tenant) ?? []), row.id]);
        }
        const agentConversations = await Promise.all(
          [...byOwner].map(([tenant, ids]) =>
            count('Conversation', {
              ...(tenant ? { tenantId: tenant } : { tenantId: { $in: [null, ''] } }),
              agent_id: { $in: ids },
            }),
          ),
        );
        const [conversations, presets, modelSpecs, favorites] = await Promise.all([
          count('Conversation', convoMatch(from, audience)),
          count('Preset', convoMatch(from, audience)),
          count('Config', specMatch(from, audience)),
          count('User', favoriteMatch(from, audience)),
        ]);
        return {
          agents: agents.length,
          conversations,
          agentConversations: agentConversations.reduce((sum, n) => sum + n, 0),
          presets,
          modelSpecs,
          favorites,
        };
      });
    },

    migrateModelUsage,

    async getConversationModelMigration(user, conversationId) {
      const Conversation = model('Conversation');
      if (!Conversation) return null;
      const doc = await Conversation.findOne({ user, conversationId })
        .select('+modelMigration')
        .lean<{ modelMigration?: ModelMigrationNotice }>();
      return doc?.modelMigration ?? null;
    },

    async clearConversationModelMigration(user, conversationId) {
      const Conversation = model('Conversation');
      if (!Conversation) return false;
      const result = await Conversation.updateOne(
        { user, conversationId, modelMigration: { $exists: true } },
        { $unset: { modelMigration: 1 } },
        { timestamps: false },
      );
      return result.modifiedCount > 0;
    },

    async clearAgentModelMigration(agentId) {
      const Agent = model('Agent');
      if (!Agent) return false;
      const result = await Agent.updateOne(
        { id: agentId, modelMigration: { $exists: true } },
        { $unset: { modelMigration: 1 } },
        { timestamps: false },
      );
      return result.modifiedCount > 0;
    },
  };
}
