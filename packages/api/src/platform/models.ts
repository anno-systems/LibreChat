import { z } from 'zod';
import { locationSchema, modelLimitsSchema, effectiveLocation } from 'librechat-data-provider';
import type { CatalogModel, OwnModel } from '@librechat/data-schemas';
import type { TLocation } from 'librechat-data-provider';

/**
 * Catalog models as the operator and tenant admin APIs take them (fork-only): `{ id, label?,
 * location?, limits? }`, or a bare id for API clients of the earlier shape. Ids must be unique
 * within a provider.
 */

const MAX_MODELS = 100;

const MODEL_ID = z.string().trim().min(1).max(128);
const LABEL = z.string().trim().min(1).max(128);

const providerModelSchema = z.union([
  MODEL_ID.transform((id): CatalogModel => ({ id })),
  z
    .object({
      id: MODEL_ID,
      label: LABEL.optional(),
      location: locationSchema.optional(),
      /** Limits of the model's own queue; absent or empty means no queue. */
      limits: modelLimitsSchema.optional(),
    })
    .strict()
    .transform(
      ({ limits, ...model }): CatalogModel => ({
        ...model,
        ...(limits && Object.keys(limits).length > 0 && { limits }),
      }),
    ),
]);

const ownModelSchema = z.union([
  MODEL_ID.transform((id): OwnModel => ({ id })),
  z.object({ id: MODEL_ID, label: LABEL.optional(), location: locationSchema.optional() }).strict(),
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

/** A model as tenant admins see it: its display name and its effective location. */
export interface TenantModelView {
  id: string;
  label?: string;
  location?: TLocation;
}

export function tenantModelView(model: OwnModel, owner: { location?: TLocation }): TenantModelView {
  const location = effectiveLocation(model, owner);
  return {
    id: model.id,
    ...(model.label && { label: model.label }),
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
