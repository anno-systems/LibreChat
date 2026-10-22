import { Schema } from 'mongoose';
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
 */

export interface PlatformProvider {
  name: string;
  label: string;
  baseURL: string;
  /** Encrypted by the caller. */
  apiKey: string;
  models: string[];
  /** Where the provider processes data, shown to tenant admins (e.g. `EU (Paris)`). */
  region?: string;
  /** Request fields the provider rejects; absent means the catalog's default. */
  dropParams?: string[];
  /** Offered to every tenant with all its models, without an assignment. */
  allTenants?: boolean;
  updatedAt?: Date;
}

export interface CatalogAssignment {
  name: string;
  models: string[];
}

export interface OwnEndpoint {
  name: string;
  baseURL: string;
  /** Encrypted by the caller. */
  apiKey: string;
  models: string[];
  /** Request fields the endpoint rejects; absent means the catalog's default. */
  dropParams?: string[];
}

export interface TenantCatalog {
  tenantId: string;
  byok: boolean;
  providers: CatalogAssignment[];
  own: OwnEndpoint[];
}

export interface PlatformCatalogMethods {
  listPlatformProviders(): Promise<PlatformProvider[]>;
  findPlatformProviders(names: string[]): Promise<PlatformProvider[]>;
  /** The providers named in `names` and every provider offered to all tenants, in one query. */
  findCatalogProviders(names: string[]): Promise<PlatformProvider[]>;
  upsertPlatformProvider(provider: PlatformProvider): Promise<PlatformProvider>;
  /** False when no provider has the name. */
  deletePlatformProvider(name: string): Promise<boolean>;
  /** The tenants a provider is assigned to. */
  tenantsUsingProvider(name: string): Promise<string[]>;
  /** Null when the operator never set the tenant's catalog. */
  getTenantCatalog(tenantId: string): Promise<TenantCatalog | null>;
  setTenantAssignments(
    tenantId: string,
    assignment: { byok: boolean; providers: CatalogAssignment[] },
  ): Promise<TenantCatalog>;
  upsertOwnEndpoint(tenantId: string, endpoint: OwnEndpoint): Promise<TenantCatalog>;
  /** False when the tenant has no endpoint of that name. */
  deleteOwnEndpoint(tenantId: string, name: string): Promise<boolean>;
}

const assignmentSchema = new Schema<CatalogAssignment>(
  { name: { type: String, required: true }, models: { type: [String], default: [] } },
  { _id: false },
);

const ownEndpointSchema = new Schema<OwnEndpoint>(
  {
    name: { type: String, required: true },
    baseURL: { type: String, required: true },
    apiKey: { type: String, required: true },
    models: { type: [String], default: [] },
    dropParams: { type: [String], default: undefined },
  },
  { _id: false },
);

const platformProviderSchema = new Schema<PlatformProvider>(
  {
    name: { type: String, required: true, unique: true },
    label: { type: String, required: true },
    baseURL: { type: String, required: true },
    apiKey: { type: String, required: true },
    models: { type: [String], default: [] },
    region: { type: String },
    dropParams: { type: [String], default: undefined },
    allTenants: { type: Boolean, default: false },
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

function toProvider(doc: PlatformProvider): PlatformProvider {
  return {
    name: doc.name,
    label: doc.label,
    baseURL: doc.baseURL,
    apiKey: doc.apiKey,
    models: [...(doc.models ?? [])],
    ...(doc.region && { region: doc.region }),
    ...(doc.dropParams && { dropParams: [...doc.dropParams] }),
    allTenants: doc.allTenants === true,
    ...(doc.updatedAt && { updatedAt: doc.updatedAt }),
  };
}

function toCatalog(doc: TenantCatalog): TenantCatalog {
  return {
    tenantId: doc.tenantId,
    byok: doc.byok === true,
    providers: (doc.providers ?? []).map(({ name, models }) => ({ name, models: [...models] })),
    own: (doc.own ?? []).map(({ name, baseURL, apiKey, models, dropParams }) => ({
      name,
      baseURL,
      apiKey,
      models: [...models],
      ...(dropParams && { dropParams: [...dropParams] }),
    })),
  };
}

export function createPlatformCatalogMethods(
  mongoose: typeof import('mongoose'),
): PlatformCatalogMethods {
  applyTenantIsolation(tenantCatalogSchema);
  const Provider: Model<PlatformProvider> =
    mongoose.models.PlatformProvider ||
    mongoose.model<PlatformProvider>('PlatformProvider', platformProviderSchema);
  const Catalog: Model<TenantCatalog> =
    mongoose.models.TenantCatalog ||
    mongoose.model<TenantCatalog>('TenantCatalog', tenantCatalogSchema);

  /** Queries also name the tenant, so they hold without strict isolation too. */
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    tenantStorage.run({ ...tenantStorage.getStore(), tenantId }, fn);

  return {
    async listPlatformProviders() {
      const docs = await Provider.find({}).sort({ name: 1 }).lean<PlatformProvider[]>();
      return docs.map(toProvider);
    },

    async findPlatformProviders(names) {
      if (names.length === 0) return [];
      const docs = await Provider.find({ name: { $in: names } }).lean<PlatformProvider[]>();
      return docs.map(toProvider);
    },

    async findCatalogProviders(names) {
      const docs = await Provider.find({
        $or: [{ name: { $in: names } }, { allTenants: true }],
      })
        .sort({ name: 1 })
        .lean<PlatformProvider[]>();
      return docs.map(toProvider);
    },

    async upsertPlatformProvider(provider) {
      const { name, ...fields } = provider;
      const unset = {
        ...(provider.region ? {} : { region: 1 }),
        ...(provider.dropParams ? {} : { dropParams: 1 }),
      };
      const doc = await Provider.findOneAndUpdate(
        { name },
        {
          $set: { ...fields, name, allTenants: provider.allTenants === true },
          ...(Object.keys(unset).length > 0 && { $unset: unset }),
        },
        { upsert: true, new: true, runValidators: true },
      ).lean<PlatformProvider>();
      return toProvider(doc as PlatformProvider);
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

    async getTenantCatalog(tenantId) {
      const doc = await inTenant(
        tenantId,
        async () => await Catalog.findOne({ tenantId }).lean<TenantCatalog>(),
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
          ).lean<TenantCatalog>(),
      );
      return toCatalog(doc as TenantCatalog);
    },

    async upsertOwnEndpoint(tenantId, endpoint) {
      const doc = await inTenant(tenantId, async () => {
        const replaced = await Catalog.findOneAndUpdate(
          { tenantId, 'own.name': endpoint.name },
          { $set: { 'own.$': endpoint } },
          { new: true, runValidators: true },
        ).lean<TenantCatalog>();
        if (replaced) return replaced;
        return await Catalog.findOneAndUpdate(
          { tenantId },
          { $push: { own: endpoint }, $setOnInsert: { tenantId, byok: false, providers: [] } },
          { upsert: true, new: true, runValidators: true },
        ).lean<TenantCatalog>();
      });
      return toCatalog(doc as TenantCatalog);
    },

    async deleteOwnEndpoint(tenantId, name) {
      const result = await inTenant(
        tenantId,
        async () =>
          await Catalog.updateOne({ tenantId, 'own.name': name }, { $pull: { own: { name } } }),
      );
      return result.modifiedCount > 0;
    },
  };
}
