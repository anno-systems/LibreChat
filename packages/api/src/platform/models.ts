import { z } from 'zod';
import {
  vendorOf,
  locationSchema,
  vendorIdSchema,
  modelLimitsSchema,
  suggestModelLabel,
  effectiveLocation,
} from 'librechat-data-provider';
import type { CatalogApi, CatalogModel, OwnModel } from '@librechat/data-schemas';
import type { TLocation, VendorId } from 'librechat-data-provider';

/**
 * Catalog models as the operator and tenant admin APIs take them (fork-only): `{ id, label?,
 * vendor?, location?, limits?, api?, baseURL?, dropParams? }` for platform providers, `{ id,
 * label?, vendor?, location? }` for a tenant's own endpoints, or a bare id for API clients of the
 * earlier shape. Ids must be unique within a provider. A model without `vendor` is detected from
 * its id (`detectVendor`); responses always carry `vendor` and the read-only `suggestedLabel`.
 */

/** Path endings of the request URL each API is called at, as operators paste them. */
const API_SUFFIXES: ReadonlyArray<readonly [string, CatalogApi]> = [
  ['/chat/completions', 'chat'],
  ['/responses', 'responses'],
  ['/messages', 'anthropic'],
];

export const catalogApiSchema: z.ZodType<CatalogApi> = z.enum(['chat', 'responses', 'anthropic']);

/**
 * A pasted URL as a base URL: query, fragment and trailing slashes removed, and a trailing
 * `/chat/completions`, `/responses` or `/messages` stripped, which names the URL's API (`api`).
 * `https://x.services.ai.azure.com/anthropic/v1/messages` becomes `…/anthropic/v1`, API
 * `anthropic`; a URL without such an ending names no API.
 */
export function normaliseBaseURL(url: string): { baseURL: string; api?: CatalogApi } {
  const parsed = new URL(url.trim());
  let path = parsed.pathname.replace(/\/+$/, '');
  let api: CatalogApi | undefined;
  for (const [suffix, suffixApi] of API_SUFFIXES) {
    if (path.toLowerCase().endsWith(suffix)) {
      path = path.slice(0, -suffix.length).replace(/\/+$/, '');
      api = suffixApi;
      break;
    }
  }
  return { baseURL: `${parsed.origin}${path}`, ...(api && { api }) };
}

/** An http(s) URL as an operator pastes it, before `normaliseBaseURL`. */
export const pastedURLSchema: z.ZodType<string> = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => /^https?:$/.test(new URL(value).protocol), 'must be http or https');

/** Request fields a model rejects, e.g. `user`; an advanced override of the built-in rules. */
export const dropParamsSchema: z.ZodType<string[], z.ZodTypeDef, string[]> = z
  .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/))
  .max(32)
  .transform((params) => [...new Set(params)]);

const MAX_MODELS = 100;

const MODEL_ID = z.string().trim().min(1).max(128);
const LABEL = z.string().trim().min(1).max(128);

const providerModelSchema = z.union([
  MODEL_ID.transform((id): CatalogModel => ({ id })),
  z
    .object({
      id: MODEL_ID,
      label: LABEL.optional(),
      /** Absent: detected from the id. */
      vendor: vendorIdSchema.optional(),
      location: locationSchema.optional(),
      /** Limits of the model's own queue; absent or empty means no queue. */
      limits: modelLimitsSchema.optional(),
      /** Absent: inferred from the model's URL, else from the provider's, else `chat`. */
      api: catalogApiSchema.optional(),
      /** Absent means the provider's; a pasted request URL is normalised. */
      baseURL: pastedURLSchema.optional(),
      /** Replaces the built-in rules (`params.ts`) for this model. */
      dropParams: dropParamsSchema.optional(),
    })
    .strict()
    .transform(({ limits, baseURL, api, ...model }): CatalogModel => {
      const url = baseURL ? normaliseBaseURL(baseURL) : undefined;
      const effectiveApi = api ?? url?.api;
      return {
        ...model,
        ...(limits && Object.keys(limits).length > 0 && { limits }),
        ...(effectiveApi && { api: effectiveApi }),
        ...(url && { baseURL: url.baseURL }),
      };
    }),
]);

const ownModelSchema = z.union([
  MODEL_ID.transform((id): OwnModel => ({ id })),
  z
    .object({
      id: MODEL_ID,
      label: LABEL.optional(),
      vendor: vendorIdSchema.optional(),
      location: locationSchema.optional(),
    })
    .strict(),
]);

/** Whether a provider lists the model id. */
export function hasModel(provider: { models: ReadonlyArray<{ id: string }> }, id: string): boolean {
  return provider.models.some((model) => model.id === id);
}

function uniqueIds<T extends { id: string }>(models: T[]): boolean {
  return new Set(models.map((model) => model.id)).size === models.length;
}

export const providerModelsSchema: z.ZodType<CatalogModel[], z.ZodTypeDef, unknown> = z
  .array(providerModelSchema)
  .min(1)
  .max(MAX_MODELS)
  .refine(uniqueIds, 'model ids must be unique');

export const ownModelsSchema: z.ZodType<OwnModel[], z.ZodTypeDef, unknown> = z
  .array(ownModelSchema)
  .min(1)
  .max(MAX_MODELS)
  .refine(uniqueIds, 'model ids must be unique');

/**
 * What every model view adds: the vendor (stored, else detected) and the display name derived
 * from the id (`suggestedLabel`, read-only), which an admin app shows as the label's placeholder.
 */
export interface ModelPresentation {
  vendor: VendorId;
  suggestedLabel: string;
}

export function modelPresentation(model: Pick<OwnModel, 'id' | 'vendor'>): ModelPresentation {
  return { vendor: vendorOf(model), suggestedLabel: suggestModelLabel(model.id) };
}

/** A model as tenant admins see it: its display name, vendor and effective location. */
export interface TenantModelView extends ModelPresentation {
  id: string;
  label?: string;
  location?: TLocation;
}

export function tenantModelView(model: OwnModel, owner: { location?: TLocation }): TenantModelView {
  const location = effectiveLocation(model, owner);
  return {
    id: model.id,
    ...(model.label && { label: model.label }),
    ...modelPresentation(model),
    ...(location && { location }),
  };
}

const MAX_SLUG = 48;
const MAX_SUFFIX = 1000;

/** A label as an id: lower case ASCII letters, digits and single dashes. */
export function slugOf(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  return slug || 'provider';
}

/**
 * The first free id for a label: its slug, else the slug with `-2`, `-3` and so on. `taken`
 * holds lower-cased names; null when every candidate is taken.
 */
export function uniqueSlug(label: string, taken: ReadonlySet<string>): string | null {
  const base = slugOf(label);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix <= MAX_SUFFIX; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}
