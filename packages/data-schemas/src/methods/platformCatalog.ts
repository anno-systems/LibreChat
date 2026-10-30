import { Schema } from 'mongoose';
import type {
  TLocation,
  TModelLimits,
  TQueueSettings,
  TProviderLimits,
} from 'librechat-data-provider';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';

/**
 * The platform's model catalog (fork-only). The operator keeps provider endpoints that are not
 * in `librechat.yaml` (`PlatformProvider`, platform-wide, no tenant) and assigns them per tenant
 * with a subset of their models (`TenantCatalog`, one per tenant, tenant-isolated). A tenant the
 * operator opts in (`byok`) may add endpoints of its own with its own key.
 *
 * Keys are stored as the caller passes them; callers encrypt them before writing.
 *
 * Models are objects (`CatalogModel`) with a display name, a location and, for platform
 * providers, the limits of the model's queue. Documents written before that (string models,
 * `region`, `country` and provider-wide `limits`) are read in the new shape until
 * `migratePlatformCatalog` rewrites them, so a replica of either version can read the catalog
 * during a rolling deploy.
 */

export type CatalogLocation = TLocation;

/** One model of a provider or own endpoint. */
export interface CatalogModel {
  /** The model's name in the provider's API. */
  id: string;
  /** Display name; absent shows the id. */
  label?: string;
  /** Where the model processes data; absent means the provider's `location`. */
  location?: CatalogLocation;
  /** Limits of the model's queue (`packages/api/src/queue`); absent means no queue. */
  limits?: TModelLimits;
}

/** A tenant's own endpoints never get a shared queue, so their models carry no limits. */
export type OwnModel = Omit<CatalogModel, 'limits'>;

export interface PlatformProvider {
  /** Fixed id, the endpoint name; derived from the label on create. */
  name: string;
  label: string;
  baseURL: string;
  /** Encrypted by the caller. */
  apiKey: string;
  models: CatalogModel[];
  /** Default location of the provider's models, shown to tenant admins. */
  location?: CatalogLocation;
  /** Request fields the provider rejects; absent means the catalog's default. */
  dropParams?: string[];
  /** Offered to every tenant with all its models, without an assignment. */
  allTenants?: boolean;
  /** How every model's queue waits (maximum wait, pause after a 429). */
  queue?: TQueueSettings;
  updatedAt?: Date;
}

export interface CatalogAssignment {
  name: string;
  /** Model ids. */
  models: string[];
}

export interface OwnEndpoint {
  name: string;
  baseURL: string;
  /** Encrypted by the caller. */
  apiKey: string;
  models: OwnModel[];
  /** Default location of the endpoint's models. */
  location?: CatalogLocation;
  /** Request fields the endpoint rejects; absent means the catalog's default. */
  dropParams?: string[];
}

export interface TenantCatalog {
  tenantId: string;
  byok: boolean;
  providers: CatalogAssignment[];
  own: OwnEndpoint[];
}

export type CreateProviderResult =
  | { ok: true; value: PlatformProvider }
  | { ok: false; error: { code: 'name_taken' } };

export interface PlatformCatalogMethods {
  listPlatformProviders(): Promise<PlatformProvider[]>;
  findPlatformProviders(names: string[]): Promise<PlatformProvider[]>;
  /** The providers named in `names` and every provider offered to all tenants, in one query. */
  findCatalogProviders(names: string[]): Promise<PlatformProvider[]>;
  /** Inserts a provider; refused when a provider already has the name. */
  createPlatformProvider(provider: PlatformProvider): Promise<CreateProviderResult>;
  upsertPlatformProvider(provider: PlatformProvider): Promise<PlatformProvider>;
  /** False when no provider has the name. */
  deletePlatformProvider(name: string): Promise<boolean>;
  /** The tenants a provider is assigned to. */
  tenantsUsingProvider(name: string): Promise<string[]>;
  /** The names of every tenant's own endpoints, across tenants. */
  listOwnEndpointNames(): Promise<string[]>;
  /** Null when the operator never set the tenant's catalog. */
  getTenantCatalog(tenantId: string): Promise<TenantCatalog | null>;
  setTenantAssignments(
    tenantId: string,
    assignment: { byok: boolean; providers: CatalogAssignment[] },
  ): Promise<TenantCatalog>;
  upsertOwnEndpoint(tenantId: string, endpoint: OwnEndpoint): Promise<TenantCatalog>;
  /** False when the tenant has no endpoint of that name. */
  deleteOwnEndpoint(tenantId: string, name: string): Promise<boolean>;
  /**
   * Rewrites providers and tenant catalogs stored in the old shape (string models, `region`,
   * `country`, provider-wide `limits`) in the new one. Idempotent; returns how many it rewrote.
   */
  migratePlatformCatalog(): Promise<{ providers: number; tenants: number }>;
}

/** A provider or tenant catalog as stored, possibly in the shape before model objects. */
interface StoredModel {
  id?: unknown;
  label?: unknown;
  location?: unknown;
  limits?: unknown;
}

interface StoredProvider extends Omit<PlatformProvider, 'models' | 'location' | 'queue'> {
  _id?: unknown;
  models?: Array<string | StoredModel>;
  location?: unknown;
  queue?: unknown;
  /** Legacy: free text, dropped. */
  region?: string;
  /** Legacy: ISO alpha-2 code, now `location`. */
  country?: string;
  /** Legacy: provider-wide limits, now per model plus `queue`. */
  limits?: TProviderLimits;
}

interface StoredOwnEndpoint extends Omit<OwnEndpoint, 'models' | 'location'> {
  models?: Array<string | StoredModel>;
  location?: unknown;
}

interface StoredCatalog extends Omit<TenantCatalog, 'own'> {
  _id?: unknown;
  own?: StoredOwnEndpoint[];
}

const assignmentSchema = new Schema<CatalogAssignment>(
  { name: { type: String, required: true }, models: { type: [String], default: [] } },
  { _id: false },
);

const locationSchema = new Schema(
  {
    type: { type: String, enum: ['country', 'eu', 'global'], required: true },
    code: { type: String },
  },
  { _id: false },
);

const modelLimitsSchema = new Schema<TModelLimits>(
  {
    concurrency: { type: Number },
    requestsPerMinute: { type: Number },
    tokensPerMinute: { type: Number },
  },
  { _id: false },
);

const queueSettingsSchema = new Schema<TQueueSettings>(
  { maxWaitSeconds: { type: Number }, pauseSeconds: { type: Number } },
  { _id: false },
);

const catalogModelSchema = new Schema<CatalogModel>(
  {
    id: { type: String, required: true },
    label: { type: String },
    location: { type: locationSchema, default: undefined },
    limits: { type: modelLimitsSchema, default: undefined },
  },
  { _id: false },
);

const ownModelSchema = new Schema<OwnModel>(
  {
    id: { type: String, required: true },
    label: { type: String },
    location: { type: locationSchema, default: undefined },
  },
  { _id: false },
);

const ownEndpointSchema = new Schema<OwnEndpoint>(
  {
    name: { type: String, required: true },
    baseURL: { type: String, required: true },
    apiKey: { type: String, required: true },
    models: { type: [ownModelSchema], default: [] },
    location: { type: locationSchema, default: undefined },
    dropParams: { type: [String], default: undefined },
  },
  { _id: false },
);

const platformProviderSchema = new Schema<StoredProvider>(
  {
    name: { type: String, required: true, unique: true },
    label: { type: String, required: true },
    baseURL: { type: String, required: true },
    apiKey: { type: String, required: true },
    models: { type: [catalogModelSchema], default: [] },
    location: { type: locationSchema, default: undefined },
    dropParams: { type: [String], default: undefined },
    allTenants: { type: Boolean, default: false },
    queue: { type: queueSettingsSchema, default: undefined },
    /** Legacy fields, kept in the schema so writes can remove them. */
    region: { type: String },
    country: { type: String },
    limits: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true },
);

const tenantCatalogSchema = new Schema<TenantCatalog>(
  {
    tenantId: { type: String, required: true, unique: true },
    byok: { type: Boolean, default: false },
    providers: { type: [assignmentSchema], default: [] },
    own: { type: [ownEndpointSchema], default: [] },
  },
  { timestamps: true },
);

const LEGACY_PROVIDER_FIELDS = { region: 1, country: 1, limits: 1 } as const;

/** Old-shape documents: a string model, or a legacy field. */
const LEGACY_PROVIDER_FILTER = {
  $or: [
    { models: { $type: 'string' } },
    { region: { $exists: true } },
    { country: { $exists: true } },
    { limits: { $exists: true } },
  ],
};
const LEGACY_CATALOG_FILTER = { 'own.models': { $type: 'string' } };

function numbersOf<K extends string>(
  value: unknown,
  keys: readonly K[],
): Partial<Record<K, number>> {
  const result: Partial<Record<K, number>> = {};
  if (value == null || typeof value !== 'object') return result;
  for (const key of keys) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === 'number') result[key] = field;
  }
  return result;
}

const MODEL_LIMIT_KEYS = ['concurrency', 'requestsPerMinute', 'tokensPerMinute'] as const;
const QUEUE_KEYS = ['maxWaitSeconds', 'pauseSeconds'] as const;

/** Set fields only (a stored subdocument may carry unset ones as `null`); none is `undefined`. */
function limitsOf(value: unknown): TModelLimits | undefined {
  const limits = numbersOf(value, MODEL_LIMIT_KEYS);
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function queueOf(value: unknown): TQueueSettings | undefined {
  const queue = numbersOf(value, QUEUE_KEYS);
  return Object.keys(queue).length > 0 ? queue : undefined;
}

/** A stored location, or the legacy `country` code. */
function locationOf(value: unknown, country?: unknown): CatalogLocation | undefined {
  if (value != null && typeof value === 'object') {
    const { type, code } = value as { type?: unknown; code?: unknown };
    if (type === 'eu' || type === 'global') return { type };
    if (type === 'country' && typeof code === 'string' && /^[A-Za-z]{2}$/.test(code)) {
      return { type: 'country', code: code.toUpperCase() };
    }
  }
  if (typeof country === 'string' && /^[A-Za-z]{2}$/.test(country)) {
    return { type: 'country', code: country.toUpperCase() };
  }
  return undefined;
}

/**
 * A stored model as an object. A string is a model of the old shape and gets `legacyLimits`
 * (the provider-wide limits it ran under) as its own.
 */
function modelOf(raw: string | StoredModel, legacyLimits?: TModelLimits): CatalogModel | null {
  if (typeof raw === 'string') {
    return { id: raw, ...(legacyLimits && { limits: { ...legacyLimits } }) };
  }
  if (raw == null || typeof raw.id !== 'string') return null;
  const location = locationOf(raw.location);
  const limits = limitsOf(raw.limits);
  return {
    id: raw.id,
    ...(typeof raw.label === 'string' && raw.label && { label: raw.label }),
    ...(location && { location }),
    ...(limits && { limits }),
  };
}

function ownModelOf(raw: string | StoredModel): OwnModel | null {
  const model = modelOf(raw);
  if (!model) return null;
  const { limits: _limits, ...own } = model;
  return own;
}

function toProvider(doc: StoredProvider): PlatformProvider {
  const legacyLimits = limitsOf(doc.limits);
  const location = locationOf(doc.location, doc.country);
  const queue = queueOf(doc.queue) ?? queueOf(doc.limits);
  return {
    name: doc.name,
    label: doc.label,
    baseURL: doc.baseURL,
    apiKey: doc.apiKey,
    models: (doc.models ?? [])
      .map((model) => modelOf(model, legacyLimits))
      .filter((model): model is CatalogModel => model != null),
    ...(location && { location }),
    ...(doc.dropParams && { dropParams: [...doc.dropParams] }),
    allTenants: doc.allTenants === true,
    ...(queue && { queue }),
    ...(doc.updatedAt && { updatedAt: doc.updatedAt }),
  };
}

function toOwnEndpoint(own: StoredOwnEndpoint): OwnEndpoint {
  const location = locationOf(own.location);
  return {
    name: own.name,
    baseURL: own.baseURL,
    apiKey: own.apiKey,
    models: (own.models ?? []).map(ownModelOf).filter((model): model is OwnModel => model != null),
    ...(location && { location }),
    ...(own.dropParams && { dropParams: [...own.dropParams] }),
  };
}

function toCatalog(doc: StoredCatalog): TenantCatalog {
  return {
    tenantId: doc.tenantId,
    byok: doc.byok === true,
    providers: (doc.providers ?? []).map(({ name, models }) => ({ name, models: [...models] })),
    own: (doc.own ?? []).map(toOwnEndpoint),
  };
}

/** The stored fields of a provider without `updatedAt` (timestamps set it). */
function providerFields(provider: PlatformProvider) {
  const { updatedAt: _updatedAt, ...fields } = provider;
  return { ...fields, allTenants: provider.allTenants === true };
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

export function createPlatformCatalogMethods(
  mongoose: typeof import('mongoose'),
): PlatformCatalogMethods {
  applyTenantIsolation(tenantCatalogSchema);
  const Provider: Model<StoredProvider> =
    mongoose.models.PlatformProvider ||
    mongoose.model<StoredProvider>('PlatformProvider', platformProviderSchema);
  const Catalog: Model<TenantCatalog> =
    mongoose.models.TenantCatalog ||
    mongoose.model<TenantCatalog>('TenantCatalog', tenantCatalogSchema);

  /** Queries also name the tenant, so they hold without strict isolation too. */
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    tenantStorage.run({ ...tenantStorage.getStore(), tenantId }, fn);

  return {
    async listPlatformProviders() {
      const docs = await Provider.find({}).sort({ name: 1 }).lean<StoredProvider[]>();
      return docs.map(toProvider);
    },

    async findPlatformProviders(names) {
      if (names.length === 0) return [];
      const docs = await Provider.find({ name: { $in: names } }).lean<StoredProvider[]>();
      return docs.map(toProvider);
    },

    async findCatalogProviders(names) {
      const docs = await Provider.find({
        $or: [{ name: { $in: names } }, { allTenants: true }],
      })
        .sort({ name: 1 })
        .lean<StoredProvider[]>();
      return docs.map(toProvider);
    },

    async createPlatformProvider(provider) {
      const fields = providerFields(provider);
      try {
        /**
         * Inserts only when no provider has the name, answering the document found before: none
         * means this call inserted it. The unique index covers concurrent calls.
         */
        const found = await Provider.findOneAndUpdate(
          { name: provider.name },
          { $setOnInsert: fields },
          { upsert: true, new: false, runValidators: true },
        ).lean<StoredProvider>();
        if (found) return { ok: false, error: { code: 'name_taken' } };
        return { ok: true, value: toProvider(fields) };
      } catch (error) {
        if (isDuplicateKey(error)) return { ok: false, error: { code: 'name_taken' } };
        throw error;
      }
    },

    async upsertPlatformProvider(provider) {
      const { name, ...fields } = providerFields(provider);
      const unset = {
        ...LEGACY_PROVIDER_FIELDS,
        ...(provider.location ? {} : { location: 1 }),
        ...(provider.dropParams ? {} : { dropParams: 1 }),
        ...(provider.queue ? {} : { queue: 1 }),
      };
      const doc = await Provider.findOneAndUpdate(
        { name },
        { $set: { ...fields, name }, $unset: unset },
        { upsert: true, new: true, runValidators: true },
      ).lean<StoredProvider>();
      return toProvider(doc as StoredProvider);
    },

    async deletePlatformProvider(name) {
      const { deletedCount } = await Provider.deleteOne({ name });
      return deletedCount > 0;
    },

    async tenantsUsingProvider(name) {
      const docs = await runAsSystem(
        async () =>
          await Catalog.find({ 'providers.name': name }, { tenantId: 1 }).lean<
            { tenantId: string }[]
          >(),
      );
      return docs.map((doc) => doc.tenantId).sort();
    },

    async listOwnEndpointNames() {
      const names = await runAsSystem(
        async () => await Catalog.distinct('own.name', { 'own.0': { $exists: true } }),
      );
      return (names as unknown[]).filter((name): name is string => typeof name === 'string');
    },

    async getTenantCatalog(tenantId) {
      const doc = await inTenant(
        tenantId,
        async () => await Catalog.findOne({ tenantId }).lean<StoredCatalog>(),
      );
      return doc ? toCatalog(doc) : null;
    },

    async setTenantAssignments(tenantId, { byok, providers }) {
      const doc = await inTenant(
        tenantId,
        async () =>
          await Catalog.findOneAndUpdate(
            { tenantId },
            { $set: { byok, providers }, $setOnInsert: { tenantId, own: [] } },
            { upsert: true, new: true, runValidators: true },
          ).lean<StoredCatalog>(),
      );
      return toCatalog(doc as StoredCatalog);
    },

    async upsertOwnEndpoint(tenantId, endpoint) {
      const doc = await inTenant(tenantId, async () => {
        const replaced = await Catalog.findOneAndUpdate(
          { tenantId, 'own.name': endpoint.name },
          { $set: { 'own.$': endpoint } },
          { new: true, runValidators: true },
        ).lean<StoredCatalog>();
        if (replaced) return replaced;
        return await Catalog.findOneAndUpdate(
          { tenantId },
          { $push: { own: endpoint }, $setOnInsert: { tenantId, byok: false, providers: [] } },
          { upsert: true, new: true, runValidators: true },
        ).lean<StoredCatalog>();
      });
      return toCatalog(doc as StoredCatalog);
    },

    async deleteOwnEndpoint(tenantId, name) {
      const result = await inTenant(
        tenantId,
        async () =>
          await Catalog.updateOne({ tenantId, 'own.name': name }, { $pull: { own: { name } } }),
      );
      return result.modifiedCount > 0;
    },

    async migratePlatformCatalog() {
      let providers = 0;
      const stale = await Provider.find(LEGACY_PROVIDER_FILTER).lean<StoredProvider[]>();
      for (const doc of stale) {
        const { name: _name, ...fields } = providerFields(toProvider(doc));
        /** Only the document as read: a write that came in between is left for the next start. */
        const { modifiedCount } = await Provider.updateOne(
          { _id: doc._id, updatedAt: doc.updatedAt },
          { $set: fields, $unset: LEGACY_PROVIDER_FIELDS },
          { timestamps: false },
        );
        providers += modifiedCount;
      }
      const tenants = await runAsSystem(async () => {
        let count = 0;
        const catalogs = await Catalog.find(LEGACY_CATALOG_FILTER).lean<StoredCatalog[]>();
        for (const doc of catalogs) {
          const { modifiedCount } = await Catalog.updateOne(
            { _id: doc._id, updatedAt: (doc as { updatedAt?: Date }).updatedAt },
            { $set: { own: toCatalog(doc).own } },
            { timestamps: false },
          );
          count += modifiedCount;
        }
        return count;
      });
      return { providers, tenants };
    },
  };
}
