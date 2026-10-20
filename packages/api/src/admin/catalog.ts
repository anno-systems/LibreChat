import type { ConfigOverrideIssue } from '@librechat/data-schemas';

/**
 * Catalog lock for the admin config API (fork-only, `ADMIN_CONFIG_CATALOG_LOCK=true`).
 *
 * Under the lock, `librechat.yaml` is the operator's catalog and admins writing through the API
 * may only narrow it:
 * - `endpoints` may contain only `custom` entries that name a catalog endpoint and set
 *   `models.default` to a subset of that endpoint's catalog models. URLs, keys, headers and
 *   every other endpoint field stay as the operator configured them.
 * - No value may reference an environment variable (`${NAME}`), because the server resolves
 *   those from its own environment and would send the secret wherever the admin points it.
 */

export type CatalogIssueCode =
  | 'catalog_env_reference'
  | 'catalog_endpoint_locked'
  | 'catalog_unknown_endpoint'
  | 'catalog_field_locked'
  | 'catalog_unknown_model'
  | 'catalog_models_fetched';

const ENV_REFERENCE = /\$\{[^}]*\}/;

interface CatalogEndpoint {
  name?: unknown;
  models?: { default?: unknown; fetch?: unknown };
}

function issue(segments: string[], code: CatalogIssueCode): ConfigOverrideIssue {
  return { path: segments.join('.'), segments, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Expands dot-path fields (`{"endpoints.custom": [...]}`) into one nested override object. */
function expand(fields: Record<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [fieldPath, value] of Object.entries(fields)) {
    const parts = fieldPath.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!isRecord(node[part])) {
        node[part] = {};
      }
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
  }
  return root;
}

function collectEnvReferences(
  value: unknown,
  segments: string[],
  issues: ConfigOverrideIssue[],
): void {
  if (typeof value === 'string') {
    if (ENV_REFERENCE.test(value)) {
      issues.push(issue(segments, 'catalog_env_reference'));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectEnvReferences(item, [...segments, String(index)], issues),
    );
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectEnvReferences(child, [...segments, key], issues);
    }
  }
}

function catalogModels(endpoint: CatalogEndpoint): string[] {
  const models = endpoint.models?.default;
  return Array.isArray(models) ? models.filter((m): m is string => typeof m === 'string') : [];
}

function checkCustomEndpoint(
  entry: unknown,
  segments: string[],
  catalog: Map<string, CatalogEndpoint>,
  issues: ConfigOverrideIssue[],
): void {
  if (!isRecord(entry)) {
    issues.push(issue(segments, 'catalog_field_locked'));
    return;
  }
  const base = typeof entry.name === 'string' ? catalog.get(entry.name) : undefined;
  if (!base) {
    issues.push(issue([...segments, 'name'], 'catalog_unknown_endpoint'));
    return;
  }
  for (const key of Object.keys(entry)) {
    if (key !== 'name' && key !== 'models') {
      issues.push(issue([...segments, key], 'catalog_field_locked'));
    }
  }
  if (entry.models === undefined) {
    return;
  }
  if (!isRecord(entry.models)) {
    issues.push(issue([...segments, 'models'], 'catalog_field_locked'));
    return;
  }
  for (const key of Object.keys(entry.models)) {
    if (key !== 'default') {
      issues.push(issue([...segments, 'models', key], 'catalog_field_locked'));
    }
  }
  const requested = entry.models.default;
  if (requested === undefined) {
    return;
  }
  // A fetched list replaces `default` at runtime, so narrowing it would not take effect.
  if (base.models?.fetch === true) {
    issues.push(issue([...segments, 'models', 'default'], 'catalog_models_fetched'));
    return;
  }
  if (!Array.isArray(requested)) {
    issues.push(issue([...segments, 'models', 'default'], 'catalog_field_locked'));
    return;
  }
  const allowed = new Set(catalogModels(base));
  requested.forEach((model, index) => {
    if (typeof model !== 'string' || !allowed.has(model)) {
      issues.push(
        issue([...segments, 'models', 'default', String(index)], 'catalog_unknown_model'),
      );
    }
  });
}

/**
 * Returns the catalog-lock violations of an admin config write; empty means allowed.
 * `fields` maps dot-paths to values (a PATCH body, or a PUT body's top-level sections);
 * `baseYaml` is the deployment config the write lands on, which holds the catalog.
 */
export function getCatalogLockIssues(
  fields: Record<string, unknown>,
  baseYaml: { endpoints?: unknown },
): ConfigOverrideIssue[] {
  const issues: ConfigOverrideIssue[] = [];
  const overrides = expand(fields);
  collectEnvReferences(overrides, [], issues);

  if (overrides.endpoints === undefined) {
    return issues;
  }
  if (!isRecord(overrides.endpoints)) {
    issues.push(issue(['endpoints'], 'catalog_endpoint_locked'));
    return issues;
  }
  for (const key of Object.keys(overrides.endpoints)) {
    if (key !== 'custom') {
      issues.push(issue(['endpoints', key], 'catalog_endpoint_locked'));
    }
  }
  const custom = overrides.endpoints.custom;
  if (custom === undefined) {
    return issues;
  }
  if (!Array.isArray(custom)) {
    issues.push(issue(['endpoints', 'custom'], 'catalog_field_locked'));
    return issues;
  }
  const baseEndpoints = isRecord(baseYaml.endpoints) ? baseYaml.endpoints.custom : undefined;
  const catalog = new Map<string, CatalogEndpoint>();
  for (const endpoint of Array.isArray(baseEndpoints) ? baseEndpoints : []) {
    if (isRecord(endpoint) && typeof endpoint.name === 'string') {
      catalog.set(endpoint.name, endpoint as CatalogEndpoint);
    }
  }
  custom.forEach((entry, index) =>
    checkCustomEndpoint(entry, ['endpoints', 'custom', String(index)], catalog, issues),
  );
  return issues;
}
