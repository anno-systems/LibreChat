import { z } from 'zod';

/**
 * Where a catalog model processes data (fork-only): a country, the EU, or anywhere. A provider
 * sets a default and a model may override it; tenant admins see the effective location per model
 * as a flag, an EU badge or a globe.
 */
export const locationSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('country'),
      /** ISO 3166-1 alpha-2, stored upper case. */
      code: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .transform((code) => code.toUpperCase()),
    })
    .strict(),
  z.object({ type: z.literal('eu') }).strict(),
  z.object({ type: z.literal('global') }).strict(),
]);

export type TLocation = z.infer<typeof locationSchema>;

/** A model's own location, else its provider's; absent when neither has one. */
export function effectiveLocation(
  model: { location?: TLocation | null },
  provider: { location?: TLocation | null },
): TLocation | undefined {
  return model.location ?? provider.location ?? undefined;
}
