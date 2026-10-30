import { vendors, getVendor } from 'librechat-data-provider';
import type { TLocation, VendorId } from 'librechat-data-provider';
import type { Endpoint } from '~/common';

/**
 * Vendor groups of the model selector (fork-only). A catalog endpoint (a platform provider or a
 * tenant's own endpoint, marked by `modelVendors`) is an account that may serve models of several
 * makers, so its models are shown under their vendor ("Mistral", "OpenAI", …) together with the
 * same vendor's models of other catalog endpoints. Each entry keeps its real endpoint, so
 * selecting it stores that endpoint and model. Models of no known vendor stay under their
 * provider's label. Every other endpoint keeps its own row.
 */

export interface VendorEntry {
  endpoint: Endpoint;
  model: string;
}

export interface VendorGroup {
  /** `vendor:<id>`, or `other:<endpoint>` for a provider's models of no known vendor. */
  key: string;
  vendor: VendorId;
  /** The vendor's name, or the provider's label for `other`. */
  label: string;
  /** For `other`: the endpoint whose icon the group shows. */
  endpoint?: Endpoint;
  entries: VendorEntry[];
}

export type SelectorItem =
  | { kind: 'endpoint'; endpoint: Endpoint }
  | ({ kind: 'vendor' } & VendorGroup);

export function isCatalogEndpoint(endpoint: Endpoint): boolean {
  return endpoint.modelVendors != null && endpoint.hosting != null;
}

/** The vendor a catalog model is shown under; `other` when the endpoint names none. */
export function vendorOfEntry(endpoint: Pick<Endpoint, 'modelVendors'>, model: string): VendorId {
  return endpoint.modelVendors?.[model] ?? 'other';
}

/** The groups the entries fall into: known vendors in the registry's order, then `other`. */
export function groupEntries(entries: VendorEntry[]): VendorGroup[] {
  const known = new Map<VendorId, VendorEntry[]>();
  const other = new Map<string, { endpoint: Endpoint; entries: VendorEntry[] }>();
  for (const entry of entries) {
    const vendor = vendorOfEntry(entry.endpoint, entry.model);
    if (vendor === 'other') {
      const group = other.get(entry.endpoint.value) ?? { endpoint: entry.endpoint, entries: [] };
      group.entries.push(entry);
      other.set(entry.endpoint.value, group);
      continue;
    }
    known.set(vendor, [...(known.get(vendor) ?? []), entry]);
  }
  const groups: VendorGroup[] = [];
  for (const { id } of vendors) {
    const grouped = known.get(id);
    if (grouped) {
      groups.push({ key: `vendor:${id}`, vendor: id, label: getVendor(id).name, entries: grouped });
    }
  }
  for (const [value, { endpoint, entries: grouped }] of other) {
    groups.push({
      key: `other:${value}`,
      vendor: 'other',
      label: endpoint.label,
      endpoint,
      entries: grouped,
    });
  }
  return groups;
}

function entriesOf(endpoint: Endpoint): VendorEntry[] {
  return (endpoint.models ?? []).map((model) => ({ endpoint, model: model.name }));
}

/**
 * The selector's top-level rows: every endpoint that is no catalog endpoint in its place, and the
 * vendor groups of all catalog endpoints where the first catalog endpoint stood.
 */
export function selectorItems(endpoints: Endpoint[]): SelectorItem[] {
  const catalog = endpoints.filter(isCatalogEndpoint);
  if (catalog.length === 0) {
    return endpoints.map((endpoint) => ({ kind: 'endpoint', endpoint }));
  }
  const groups = groupEntries(catalog.flatMap(entriesOf));
  const items: SelectorItem[] = [];
  let placed = false;
  for (const endpoint of endpoints) {
    if (!isCatalogEndpoint(endpoint)) {
      items.push({ kind: 'endpoint', endpoint });
      continue;
    }
    if (!placed) {
      placed = true;
      items.push(...groups.map((group) => ({ kind: 'vendor' as const, ...group })));
    }
  }
  return items;
}

/** A catalog model's location: its own, else its provider's. */
export function locationOfEntry(
  endpoint: Pick<Endpoint, 'modelLocations' | 'hosting'>,
  model: string,
): TLocation | undefined {
  return endpoint.modelLocations?.[model] ?? endpoint.hosting?.location;
}

/** Whether a search term finds a catalog model by its label, id, vendor or provider label. */
export function catalogModelMatches(
  endpoint: Pick<Endpoint, 'modelVendors' | 'modelNames' | 'hosting'>,
  model: string,
  term: string,
): boolean {
  const query = term.trim().toLowerCase();
  if (!query) {
    return true;
  }
  const vendor = vendorOfEntry(endpoint, model);
  return [
    model,
    endpoint.modelNames?.[model],
    vendor === 'other' ? undefined : getVendor(vendor).name,
    endpoint.hosting?.label,
  ].some((text) => text != null && text.toLowerCase().includes(query));
}
