import { z } from 'zod';

/**
 * Kinds of the platform operator's banners (fork-only). `info` looks like an upstream banner;
 * the others carry a status colour and icon. Tenant admins' own banners have no kind.
 */
export const bannerKinds = ['info', 'maintenance', 'warning', 'outage'] as const;

export type BannerKind = (typeof bannerKinds)[number];

export const bannerKindSchema = z.enum(bannerKinds);

/** A stored or received kind, with anything absent or unknown read as `info`. */
export function toBannerKind(kind: unknown): BannerKind {
  return bannerKinds.includes(kind as BannerKind) ? (kind as BannerKind) : 'info';
}
