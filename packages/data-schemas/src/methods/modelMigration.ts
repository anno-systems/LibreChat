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
  /** Display name shown to users ("Mistral Large 3"); the model id stands in without one. */
  label?: string;
}

/** How long a migrated agent's notice is shown on new chats with it. */
export const AGENT_NOTICE_WINDOW_MS: number = 30 * 24 * 60 * 60 * 1000;
/** How long a user's acknowledgement of a notice is kept; beyond the agent notice window. */
const SEEN_TTL_SECONDS = 90 * 24 * 60 * 60;

/** What enabling the successor changed in one tenant. */
export interface SuccessorEnabled {
  /** Config documents (tenant, group or role) whose narrowed lists gained the successor. */
  configs: number;
  /** Whether the tenant's catalog assignment gained the successor. */
  assignment: boolean;
}

export interface EnableSuccessorInput {
  from: ModelRef;
  to: ModelRef;
  /** Platform audiences only: tenant migrations need an enabled target already. */
  audience: { tenantIds: string[] } | { all: true };
  /** Whether `to.endpoint` is a platform provider assigned per tenant (not offered to all). */
  assignProvider: boolean;
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

/**
 * Whose documents a query or rewrite reaches. A tenant audience may leave out users (a migration
 * scoped by `exceptGroups`): their agents (by `author`), conversations, presets and favorites are
 * neither counted nor rewritten, and config documents are not touched at all, because their model
 * specs apply to the left-out users too.
 */
export type MigrationAudience =
  | { tenantId: string; exceptUsers?: string[] }
  | { tenantIds: string[] }
  | { all: true };

/** The users of a tenant who are members of any of the listed groups (ids of `User`). */
export type GroupMembersResult =
  | { ok: true; userIds: string[] }
  | { ok: false; error: { code: 'unknown_group'; groupIds: string[] } };

/** A model whose use is counted; `agentProviders` are the agent `provider` values that mean the endpoint. */
export interface UsageQuery extends ModelRef {
  agentProviders: string[];
}

export interface ModelUsage extends ModelRef {
  agents: number;
  conversations: number;
}

/**
 * A model that stored documents of a tenant name: agents by (`provider`, `model`), active
 * conversations by (`endpoint`, `model`). `endpoint` is the stored value (an agent's provider).
 */
export interface UsedModel {
  tenantId: string;
  endpoint: string;
  model: string;
  agents: number;
  conversations: number;
}

export interface UsedModelsOptions {
  /** Conversation endpoints left out (the agents endpoint, whose model is the agent's). */
  exceptConversationEndpoints?: string[];
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

export interface RetargetInput {
  scope: string;
  tenantIds?: string[];
  /** Redirects that end at this model … */
  from: ModelRef;
  /** … end here instead. */
  to: ModelRef;
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
  /**
   * The users of `tenantId` in any of `groupIds` (group `memberIds` hold a user's
   * `idOnTheSource`, else its id). Ids that name no group of the tenant fail as `unknown_group`.
   */
  findGroupMemberUsers(tenantId: string, groupIds: string[]): Promise<GroupMembersResult>;
  /** Every redirect, from the in-memory copy; starts a reload when it is stale. */
  getModelRedirects(): ModelRedirect[];
  countModelUsage(models: UsageQuery[], audience: MigrationAudience): Promise<ModelUsage[]>;
  previewModelMigration(
    from: ModelRef,
    agentProviders: string[],
    audience: MigrationAudience,
  ): Promise<MigrationCounts>;
  /**
   * Every (endpoint, model) the audience's agents and active conversations name, per tenant,
   * counted by aggregation. Documents without a tenant and platform agents' copies (which
   * follow their definition) are left out, as migrations leave them.
   */
  listUsedModels(audience: MigrationAudience, options?: UsedModelsOptions): Promise<UsedModel[]>;
  /** Rewrites the stored documents in batches; running it again changes nothing. */
  migrateModelUsage(input: MigrateModelInput): Promise<MigrateModelResult>;
  /**
   * Enables `to` wherever a tenant of the audience had `from` enabled: in narrowed lists of
   * config documents and in the catalog assignment. Tenants without `from` are not touched.
   */
  enableSuccessor(input: EnableSuccessorInput): Promise<Record<string, SuccessorEnabled>>;
  /** Points redirects of the same scope and audience that end at `from` to `to`; the count. */
  retargetModelRedirects(input: RetargetInput): Promise<number>;
  /** The conversation's unseen notice, for its owner. */
  getConversationModelMigration(
    user: string,
    conversationId: string,
  ): Promise<ModelMigrationNotice | null>;
  /** False when the conversation had no notice; the user has then seen the migration. */
  clearConversationModelMigration(user: string, conversationId: string): Promise<boolean>;
  /**
   * The agent's notice for one user: set by a migration less than `AGENT_NOTICE_WINDOW_MS` ago
   * and not yet seen by the user.
   */
  getAgentModelMigration(
    agentId: string,
    userId: string,
    now?: Date,
  ): Promise<ModelMigrationNotice | null>;
  /** Records that the user saw the agent's notice; false when it has none. */
  markAgentModelMigrationSeen(agentId: string, userId: string): Promise<boolean>;
}

const modelRefSchema = new Schema<ModelRef>(
  {
    endpoint: { type: String, required: true, maxlength: 128 },
    model: { type: String, required: true, maxlength: 256 },
    label: { type: String, maxlength: 128 },
  },
  { _id: false },
);

interface SeenNotice {
  migrationId: string;
  userId: string;
  at: Date;
}

/** One row per user and migration: who has seen a notice, so shared agents scale. */
const seenNoticeSchema = new Schema<SeenNotice>({
  migrationId: { type: String, required: true },
  userId: { type: String, required: true },
  at: { type: Date, required: true, default: () => new Date() },
});
seenNoticeSchema.index({ migrationId: 1, userId: 1 }, { unique: true });
seenNoticeSchema.index({ at: 1 }, { expireAfterSeconds: SEEN_TTL_SECONDS });

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
const OBJECT_ID = /^[0-9a-f]{24}$/i;

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

const toRef = (ref: ModelRef): ModelRef => ({
  endpoint: ref.endpoint,
  model: ref.model,
  ...(ref.label && { label: ref.label }),
});

/** A model list entry's id (`models.default` holds names or `{ name }`). */
const listedName = (item: unknown) =>
  typeof item === 'string' ? item : String((item as { name?: string } | null)?.name ?? '');

interface EndpointEntry {
  name?: string;
  models?: { default?: unknown[] };
}

function toRedirect(doc: StoredRedirect): ModelRedirect {
  return {
    redirectId: doc.redirectId,
    scope: doc.scope,
    ...(doc.tenantIds && { tenantIds: [...doc.tenantIds] }),
    from: toRef(doc.from),
    to: toRef(doc.to),
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

/** Whether the audience leaves out users, so config documents stay as they are. */
const isScoped = (audience: MigrationAudience) =>
  'exceptUsers' in audience && audience.exceptUsers != null;

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
  const Seen: Model<SeenNotice> =
    mongoose.models.ModelMigrationSeen ||
    mongoose.model<SeenNotice>('ModelMigrationSeen', seenNoticeSchema);
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

  /**
   * Leaves out the documents the audience's excepted users own. `$nor` keeps the `_id` key free
   * for the batch cursor of `rewrite`.
   */
  function exceptOwners(
    audience: MigrationAudience,
    field: 'author' | 'user' | '_id',
  ): Record<string, unknown> {
    if (!('exceptUsers' in audience) || !audience.exceptUsers?.length) return {};
    const ids =
      field === 'user'
        ? audience.exceptUsers
        : audience.exceptUsers.map((id) => new mongoose.Types.ObjectId(id));
    return { $nor: [{ [field]: { $in: ids } }] };
  }

  const agentMatch = (from: ModelRef, agentProviders: string[], audience: MigrationAudience) => ({
    ...audienceFilter(audience),
    ...exceptOwners(audience, 'author'),
    provider: { $in: agentProviders.length > 0 ? agentProviders : [from.endpoint] },
    model: from.model,
    /* A platform agent's copy follows its definition, which only the operator changes. */
    platformAgentId: { $exists: false },
  });
  const convoMatch = (from: ModelRef, audience: MigrationAudience) => ({
    ...audienceFilter(audience),
    ...exceptOwners(audience, 'user'),
    endpoint: from.endpoint,
    model: from.model,
  });
  /** Counts and previews cover active chats: neither archived nor temporary. */
  const active = { isArchived: { $ne: true }, isTemporary: { $ne: true } };
  const specMatch = (from: ModelRef, audience: MigrationAudience) => ({
    ...audienceFilter(audience),
    'overrides.modelSpecs.list': {
      $elemMatch: { 'preset.endpoint': from.endpoint, 'preset.model': from.model },
    },
  });
  const favoriteMatch = (from: ModelRef, audience: MigrationAudience) => ({
    ...audienceFilter(audience),
    ...exceptOwners(audience, '_id'),
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

  async function markSeen(migrationId: string, userId: string): Promise<void> {
    await Seen.updateOne(
      { migrationId, userId },
      { $setOnInsert: { migrationId, userId, at: new Date() } },
      { upsert: true },
    );
  }

  async function agentNotice(agentId: string): Promise<ModelMigrationNotice | null> {
    const Agent = model('Agent');
    if (!Agent) return null;
    const doc = await Agent.findOne({ id: agentId })
      .select('modelMigration')
      .lean<{ modelMigration?: ModelMigrationNotice }>();
    return doc?.modelMigration ?? null;
  }

  /** Adds `model` to a model list once, keeping how the list writes its entries. */
  const withModel = (list: unknown[], model: string) =>
    list.some((item) => listedName(item) === model) ? list : [...list, model];

  /**
   * The successor's place in one document's narrowed endpoints, or null when the document does
   * not enable the old model or already offers the successor. `inherited` is the list a lower
   * layer (the tenant's base document) narrows the successor's endpoint to.
   */
  function enableInEntries(
    entries: EndpointEntry[],
    from: ModelRef,
    to: ModelRef,
    inherited: unknown[] | undefined,
  ): EndpointEntry[] | null {
    const old = entries.find((e) => e.name === from.endpoint);
    if (!old?.models?.default?.some((item) => listedName(item) === from.model)) return null;
    const index = entries.findIndex((e) => e.name === to.endpoint);
    const target = index >= 0 ? entries[index] : undefined;
    if (target && !target.models?.default) return null;
    const current = target?.models?.default ?? inherited;
    /* Neither this document nor the base narrows the successor's endpoint: it is offered whole. */
    if (!current) return null;
    const next = withModel(current, to.model);
    if (target && next === current) return null;
    const entry: EndpointEntry = {
      ...(target ?? { name: to.endpoint }),
      models: { ...(target?.models ?? {}), default: next },
    };
    return index >= 0 ? entries.map((e, i) => (i === index ? entry : e)) : [...entries, entry];
  }

  interface ConfigRow {
    _id: unknown;
    tenantId?: string;
    principalType?: string;
    principalId?: string;
    configVersion?: number;
    overrides?: { endpoints?: { custom?: EndpointEntry[] } };
  }

  async function enableSuccessor(
    input: EnableSuccessorInput,
  ): Promise<Record<string, SuccessorEnabled>> {
    const { from, to, audience } = input;
    const changed: Record<string, SuccessorEnabled> = {};
    const mark = (tenantId: string) => (changed[tenantId] ??= { configs: 0, assignment: false });

    await runAsSystem(async () => {
      const Config = model('Config');
      if (Config) {
        const docs = await Config.find({
          ...audienceFilter(audience),
          'overrides.endpoints.custom': {
            $elemMatch: { name: from.endpoint, 'models.default': from.model },
          },
        })
          .select('_id tenantId principalType principalId configVersion overrides.endpoints')
          .lean<ConfigRow[]>();
        const bases = new Map<string, EndpointEntry[]>();
        const baseOf = async (tenantId: string | undefined) => {
          const key = tenantId ?? '';
          if (!bases.has(key)) {
            const base = await Config.findOne({
              tenantId: tenantId ?? { $in: [null, ''] },
              principalType: 'role',
              principalId: '__base__',
            })
              .select('overrides.endpoints')
              .lean<ConfigRow>();
            bases.set(key, base?.overrides?.endpoints?.custom ?? []);
          }
          return bases.get(key)!;
        };
        for (const doc of docs) {
          const isBase = doc.principalType === 'role' && doc.principalId === '__base__';
          const inherited = isBase
            ? undefined
            : (await baseOf(doc.tenantId)).find((e) => e.name === to.endpoint)?.models?.default;
          const entries = enableInEntries(
            doc.overrides?.endpoints?.custom ?? [],
            from,
            to,
            inherited,
          );
          if (!entries) continue;
          /* Guarded by the version read: a concurrent admin write wins and is not overwritten. */
          const result = await Config.updateOne(
            { _id: doc._id, configVersion: doc.configVersion ?? { $in: [0, null] } },
            {
              $set: { 'overrides.endpoints.custom': entries },
              $inc: { configVersion: 1 },
            },
          );
          if (result.modifiedCount > 0) mark(doc.tenantId ?? '').configs += 1;
        }
      }

      const Catalog = model('TenantCatalog');
      if (!Catalog || !input.assignProvider) return;
      const holders = await Catalog.find({
        ...audienceFilter(audience),
        providers: { $elemMatch: { name: from.endpoint, models: from.model } },
      })
        .select('tenantId providers')
        .lean<Array<{ tenantId: string; providers: Array<{ name: string; models: string[] }> }>>();
      for (const holder of holders) {
        const entry = holder.providers.find((p) => p.name === to.endpoint);
        if (entry?.models.includes(to.model)) continue;
        const result = entry
          ? await Catalog.updateOne(
              { tenantId: holder.tenantId, 'providers.name': to.endpoint },
              { $addToSet: { 'providers.$.models': to.model } },
            )
          : await Catalog.updateOne(
              { tenantId: holder.tenantId, 'providers.name': { $ne: to.endpoint } },
              { $push: { providers: { name: to.endpoint, models: [to.model] } } },
            );
        if (result.modifiedCount > 0) mark(holder.tenantId).assignment = true;
      }
    });
    return changed;
  }

  async function findGroupMemberUsers(
    tenantId: string,
    groupIds: string[],
  ): Promise<GroupMembersResult> {
    const requested = [...new Set(groupIds)];
    const valid = requested.filter((id) => OBJECT_ID.test(id));
    return inAudience({ tenantId }, async () => {
      const Group = model('Group');
      const User = model('User');
      const groups =
        Group && valid.length > 0
          ? await Group.find({ tenantId, _id: { $in: valid } })
              .select('_id memberIds')
              .lean<Array<{ _id: unknown; memberIds?: string[] }>>()
          : [];
      const found = new Set(groups.map((group) => String(group._id)));
      const unknown = requested.filter((id) => !found.has(id.toLowerCase()));
      if (unknown.length > 0)
        return { ok: false, error: { code: 'unknown_group', groupIds: unknown } };
      const memberIds = [...new Set(groups.flatMap((group) => group.memberIds ?? []))];
      if (!User || memberIds.length === 0) return { ok: true, userIds: [] };
      /* As `getUserPrincipals` decides membership: by `idOnTheSource`, else by the user's id. */
      const rawIds = memberIds.filter((id) => OBJECT_ID.test(id));
      const users = await User.find({
        tenantId,
        $or: [
          { idOnTheSource: { $in: memberIds } },
          ...(rawIds.length > 0
            ? [{ _id: { $in: rawIds }, idOnTheSource: { $in: [null, ''] } }]
            : []),
        ],
      } as FilterQuery<Record<string, unknown>>)
        .select('_id')
        .lean<Row[]>();
      return { ok: true, userIds: users.map((user) => String(user._id)) };
    });
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
      /* Model specs apply to every user of the document, the left-out ones too. */
      if (!isScoped(audience)) {
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
      }
      /* A user who already pinned the successor keeps that pin, not a duplicate. */
      await rewrite(
        'User',
        {
          ...audienceFilter(audience),
          ...exceptOwners(audience, '_id'),
          $and: [
            { favorites: { $elemMatch: { endpoint: from.endpoint, model: from.model } } },
            { favorites: { $elemMatch: { endpoint: to.endpoint, model: to.model } } },
          ],
        },
        { $pull: { favorites: { endpoint: from.endpoint, model: from.model } } },
        batchSize,
        (rows) => {
          tally('favorites', rows);
          rows.forEach((row) => userIds.add(String(row._id)));
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
    findGroupMemberUsers,

    async countModelUsage(models, audience) {
      return inAudience(audience, () =>
        Promise.all(
          models.map(async (ref) => {
            const [agents, conversations] = await Promise.all([
              count('Agent', agentMatch(ref, ref.agentProviders, audience)),
              count('Conversation', { ...convoMatch(ref, audience), ...active }),
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
              ...active,
            }),
          ),
        );
        const [conversations, presets, modelSpecs, favorites] = await Promise.all([
          count('Conversation', { ...convoMatch(from, audience), ...active }),
          count('Preset', convoMatch(from, audience)),
          isScoped(audience) ? 0 : count('Config', specMatch(from, audience)),
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

    async listUsedModels(audience, options = {}) {
      return inAudience(audience, async () => {
        const tenant = { tenantId: { $exists: true, $nin: [null, ''] } };
        const named = { $type: 'string', $ne: '' };
        const group = (field: string) => [
          {
            $group: {
              _id: { tenantId: '$tenantId', endpoint: `$${field}`, model: '$model' },
              count: { $sum: 1 },
            },
          },
        ];
        const Agent = model('Agent');
        const Conversation = model('Conversation');
        const except = options.exceptConversationEndpoints ?? [];
        type Grouped = {
          _id: { tenantId: string; endpoint: string; model: string };
          count: number;
        };
        const [agents, conversations] = await Promise.all([
          Agent
            ? Agent.aggregate<Grouped>([
                {
                  $match: {
                    ...audienceFilter(audience),
                    ...exceptOwners(audience, 'author'),
                    ...('all' in audience && tenant),
                    provider: named,
                    model: named,
                    platformAgentId: { $exists: false },
                  },
                },
                ...group('provider'),
              ])
            : [],
          Conversation
            ? Conversation.aggregate<Grouped>([
                {
                  $match: {
                    ...audienceFilter(audience),
                    ...exceptOwners(audience, 'user'),
                    ...('all' in audience && tenant),
                    endpoint: { ...named, ...(except.length > 0 && { $nin: except }) },
                    model: named,
                    ...active,
                  },
                },
                ...group('endpoint'),
              ])
            : [],
        ]);
        const used = new Map<string, UsedModel>();
        const add = (rows: Grouped[], kind: 'agents' | 'conversations') => {
          for (const { _id, count: n } of rows) {
            const key = `${_id.tenantId}\u0000${_id.endpoint}\u0000${_id.model}`;
            const entry = used.get(key) ?? { ..._id, agents: 0, conversations: 0 };
            entry[kind] += n;
            used.set(key, entry);
          }
        };
        add(agents, 'agents');
        add(conversations, 'conversations');
        return [...used.values()];
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
      const previous = await Conversation.findOneAndUpdate(
        { user, conversationId, modelMigration: { $exists: true } },
        { $unset: { modelMigration: 1 } },
        { timestamps: false, projection: { modelMigration: 1 } },
      ).lean<{ modelMigration?: ModelMigrationNotice }>();
      const migrationId = previous?.modelMigration?.id;
      if (!migrationId) return false;
      await markSeen(migrationId, user);
      return true;
    },

    async getAgentModelMigration(agentId, userId, now = new Date()) {
      const notice = await agentNotice(agentId);
      if (!notice || now.getTime() - new Date(notice.at).getTime() > AGENT_NOTICE_WINDOW_MS) {
        return null;
      }
      const seen = await Seen.exists({ migrationId: notice.id, userId });
      return seen ? null : notice;
    },

    async markAgentModelMigrationSeen(agentId, userId) {
      const notice = await agentNotice(agentId);
      if (!notice) return false;
      await markSeen(notice.id, userId);
      return true;
    },

    enableSuccessor,

    async retargetModelRedirects({ scope, tenantIds, from, to }) {
      const audience = tenantIds
        ? { tenantIds: [...new Set(tenantIds)].sort() }
        : { tenantIds: { $exists: false } };
      const result = await Redirect.updateMany(
        { scope, ...audience, 'to.endpoint': from.endpoint, 'to.model': from.model },
        { $set: { to: toRef(to) } },
      );
      if (result.modifiedCount > 0) await loadModelRedirects();
      return result.modifiedCount;
    },
  };
}
