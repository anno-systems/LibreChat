import { Schema } from 'mongoose';
import { bannerKinds, toBannerKind } from 'librechat-data-provider';
import type { BannerKind } from 'librechat-data-provider';
import type { Model } from 'mongoose';

/**
 * Banners from the platform operator (fork-only), for every tenant or for chosen ones. Upstream's
 * `Banner` is tenant-isolated, so a platform-wide notice (an anniversary, planned downtime, a
 * broken feature) would need a copy per tenant and miss tenants created later; these live
 * platform-wide, without a tenant, and the banner route shows the one that applies.
 */
export interface PlatformBanner {
  bannerId: string;
  /** HTML with text tags only; the chat sanitizes it as it does upstream banners. */
  message: string;
  displayFrom: Date;
  displayTo?: Date;
  /** Shown before sign-in too. */
  isPublic: boolean;
  /** Users cannot close it. */
  persistable: boolean;
  /** The tenants that see it; absent means every tenant. */
  tenantIds?: string[];
  /** How the chat shows it; banners stored without one are `info`. */
  kind?: BannerKind;
  updatedAt?: Date;
}

export interface PlatformBannerMethods {
  listPlatformBanners(): Promise<PlatformBanner[]>;
  upsertPlatformBanner(banner: PlatformBanner): Promise<PlatformBanner>;
  /** False when no banner has the id. */
  deletePlatformBanner(bannerId: string): Promise<boolean>;
  /** The latest-starting banner shown now to `tenantId`, if any. */
  findActivePlatformBanner(
    tenantId: string | undefined,
    now?: Date,
  ): Promise<PlatformBanner | null>;
}

const platformBannerSchema = new Schema<PlatformBanner>(
  {
    bannerId: { type: String, required: true, unique: true },
    message: { type: String, required: true },
    displayFrom: { type: Date, required: true },
    displayTo: { type: Date },
    isPublic: { type: Boolean, default: false },
    persistable: { type: Boolean, default: false },
    tenantIds: { type: [String], default: undefined },
    kind: { type: String, enum: bannerKinds, default: 'info' },
  },
  { timestamps: true },
);
platformBannerSchema.index({ displayFrom: -1 });

function toBanner(doc: PlatformBanner): PlatformBanner {
  return {
    bannerId: doc.bannerId,
    message: doc.message,
    displayFrom: doc.displayFrom,
    ...(doc.displayTo && { displayTo: doc.displayTo }),
    isPublic: doc.isPublic === true,
    persistable: doc.persistable === true,
    kind: toBannerKind(doc.kind),
    ...(doc.tenantIds && { tenantIds: [...doc.tenantIds] }),
    ...(doc.updatedAt && { updatedAt: doc.updatedAt }),
  };
}

export function createPlatformBannerMethods(
  mongoose: typeof import('mongoose'),
): PlatformBannerMethods {
  const Banner: Model<PlatformBanner> =
    mongoose.models.PlatformBanner ||
    mongoose.model<PlatformBanner>('PlatformBanner', platformBannerSchema);

  return {
    async listPlatformBanners() {
      const docs = await Banner.find({}).sort({ displayFrom: -1 }).lean<PlatformBanner[]>();
      return docs.map(toBanner);
    },

    async upsertPlatformBanner(banner) {
      const { bannerId, ...fields } = banner;
      const unset = {
        ...(banner.displayTo ? {} : { displayTo: 1 }),
        ...(banner.tenantIds ? {} : { tenantIds: 1 }),
      };
      const doc = await Banner.findOneAndUpdate(
        { bannerId },
        {
          $set: { ...fields, bannerId, kind: banner.kind ?? 'info' },
          ...(Object.keys(unset).length > 0 && { $unset: unset }),
        },
        { upsert: true, new: true, runValidators: true },
      ).lean<PlatformBanner>();
      return toBanner(doc as PlatformBanner);
    },

    async deletePlatformBanner(bannerId) {
      const { deletedCount } = await Banner.deleteOne({ bannerId });
      return deletedCount > 0;
    },

    async findActivePlatformBanner(tenantId, now = new Date()) {
      const audience = tenantId
        ? { $or: [{ tenantIds: { $exists: false } }, { tenantIds: tenantId }] }
        : { tenantIds: { $exists: false } };
      const doc = await Banner.findOne({
        displayFrom: { $lte: now },
        $and: [{ $or: [{ displayTo: { $gte: now } }, { displayTo: null }] }, audience],
      })
        .sort({ displayFrom: -1 })
        .lean<PlatformBanner>();
      return doc ? toBanner(doc) : null;
    },
  };
}
