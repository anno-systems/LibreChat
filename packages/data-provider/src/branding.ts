import { z } from 'zod';

/**
 * Tenant branding (fork-only): what a tenant's sign-in page and chat show as their own name, logo,
 * favicon and footer. It sits under `interface.branding`, so the tenant's base config document
 * can set it like any other interface field; colors stay in `interface.theme`.
 *
 * Images are an `https:` URL or an inline `data:` image, small enough to travel in the startup
 * config. Images render only in `<img>` and icon links, where an SVG cannot run scripts.
 */

/** Longest inline image accepted: a logo or favicon of about 96 KB. */
export const MAX_BRANDING_IMAGE_LENGTH = 131_072;
export const MAX_BRANDING_TITLE_LENGTH = 60;
export const MAX_BRANDING_FOOTER_LENGTH = 500;

const DATA_IMAGE =
  /^data:image\/(png|jpeg|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Whether a branding image is an `https:` URL or an inline base64 image of an allowed type. */
export function isBrandingImage(value: string): boolean {
  if (value.length > MAX_BRANDING_IMAGE_LENGTH) {
    return false;
  }
  if (value.startsWith('data:')) {
    return DATA_IMAGE.test(value);
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

const brandingImageSchema = z.string().refine(isBrandingImage, {
  message: 'must be an https URL or a base64 data:image of at most 128 KB',
});

export const brandingSchema = z
  .object({
    /** Replaces `APP_TITLE` in the tab title and on the sign-in page. */
    appTitle: z.string().trim().min(1).max(MAX_BRANDING_TITLE_LENGTH).optional(),
    /** Replaces the LibreChat logo on the sign-in pages. */
    logo: brandingImageSchema.optional(),
    /** Replaces the favicon. */
    favicon: brandingImageSchema.optional(),
    /** Replaces `CUSTOM_FOOTER` (Markdown, `|` separates parts). */
    footer: z.string().max(MAX_BRANDING_FOOTER_LENGTH).optional(),
  })
  .strict();

export type TBranding = z.infer<typeof brandingSchema>;
