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
 * - `mcpServers` (or its alias `mcpConfig`) may name only servers of `librechat.yaml` and set only
 *   their boolean switches `enabled` and `chatMenu`. A URL, header or new server would let the
 *   admin send users' tokens (`{{LIBRECHAT_OPENID_ACCESS_TOKEN}}`) to a server of their choosing.
 *   A tombstone under these sections may only target those two switches.
 * - `endpoints.agents` may set only `pullRequests.enabled`, the boolean that switches the
 *   conversation pull request chip on or off for the scope. Where pull requests are looked up,
 *   with which token and which repositories, stays as the operator configured it.
 */

export type CatalogIssueCode =
  | 'catalog_env_reference'
  | 'catalog_endpoint_locked'
  | 'catalog_unknown_endpoint'
  | 'catalog_field_locked'
  | 'catalog_unknown_model'
  | 'catalog_models_fetched'
  | 'catalog_unknown_mcp_server';

/** Sections that hold MCP servers; `mcpConfig` is the resolved alias of `mcpServers`. */
const MCP_SECTIONS = ['mcpServers', 'mcpConfig'] as const;
/** The MCP server fields an admin may set under the lock, each a boolean. */
const MCP_SWITCHES: ReadonlySet<string> = new Set(['enabled', 'chatMenu']);

const ENV_REFERENCE = /\$\{[^}]*\}/;

/** The agents endpoint fields an admin may set under the lock: section, then its booleans. */
const AGENTS_SWITCHES: Readonly<Record<string, ReadonlySet<string>>> = {
  pullRequests: new Set(['enabled']),
};

/** The deployment config a write lands on, which holds the catalog. */
type CatalogBase = { endpoints?: unknown; mcpServers?: unknown };

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

function checkMCPServers(
  section: string,
  servers: unknown,
  baseServers: unknown,
  issues: ConfigOverrideIssue[],
): void {
  if (!isRecord(servers)) {
    issues.push(issue([section], 'catalog_field_locked'));
    return;
  }
  const catalog = isRecord(baseServers) ? baseServers : {};
  for (const [name, entry] of Object.entries(servers)) {
    if (!Object.prototype.hasOwnProperty.call(catalog, name)) {
      issues.push(issue([section, name], 'catalog_unknown_mcp_server'));
      continue;
    }
    if (!isRecord(entry)) {
      issues.push(issue([section, name], 'catalog_field_locked'));
      continue;
    }
    for (const [key, value] of Object.entries(entry)) {
      if (!MCP_SWITCHES.has(key) || typeof value !== 'boolean') {
        issues.push(issue([section, name, key], 'catalog_field_locked'));
      }
    }
  }
}

function checkAgentsEndpoint(agents: unknown, issues: ConfigOverrideIssue[]): void {
  const segments = ['endpoints', 'agents'];
  if (!isRecord(agents)) {
    issues.push(issue(segments, 'catalog_field_locked'));
    return;
  }
  for (const [section, value] of Object.entries(agents)) {
    const switches = AGENTS_SWITCHES[section];
    if (switches == null || !isRecord(value)) {
      issues.push(issue([...segments, section], 'catalog_field_locked'));
      continue;
    }
    for (const [key, flag] of Object.entries(value)) {
      if (!switches.has(key) || typeof flag !== 'boolean') {
        issues.push(issue([...segments, section, key], 'catalog_field_locked'));
      }
    }
  }
}

/**
 * Returns the catalog-lock violation of an admin config tombstone, or `null` when allowed.
 * Only MCP sections are restricted: there a tombstone may target `<section>.<name>.enabled` or
 * `<section>.<name>.chatMenu`, nothing broader or deeper.
 */
export function getCatalogLockTombstoneIssue(fieldPath: string): ConfigOverrideIssue | null {
  const segments = fieldPath.split('.');
  if (!(MCP_SECTIONS as readonly string[]).includes(segments[0])) {
    return null;
  }
  if (segments.length === 3 && MCP_SWITCHES.has(segments[2])) {
    return null;
  }
  return issue(segments, 'catalog_field_locked');
}

/**
 * Returns the catalog-lock violations of an admin config write; empty means allowed.
 * `fields` maps dot-paths to values (a PATCH body, or a PUT body's top-level sections);
 * `baseYaml` is the deployment config the write lands on, which holds the catalog.
 */
export function getCatalogLockIssues(
  fields: Record<string, unknown>,
  baseYaml: CatalogBase,
): ConfigOverrideIssue[] {
  return checkOverrides(expand(fields), baseYaml);
}

/** Nests a value under its path segments, which may contain dots (`{ segments, value }` writes). */
function nest(segments: readonly string[], value: unknown): Record<string, unknown> {
  let node: unknown = value;
  for (let index = segments.length - 1; index >= 0; index--) {
    node = { [segments[index]]: node };
  }
  return isRecord(node) ? node : {};
}

/**
 * The catalog-lock violations of one write addressed by path segments (a PATCH entry, or a `set`
 * of the changes endpoint). Segments are taken as they are, so a key containing a dot stays one key.
 */
export function getCatalogLockEntryIssues(
  segments: readonly string[],
  value: unknown,
  baseYaml: CatalogBase,
): ConfigOverrideIssue[] {
  if (segments.length === 0) {
    return isRecord(value) ? checkOverrides(value, baseYaml) : [];
  }
  return checkOverrides(nest(segments, value), baseYaml);
}

/** One change of `POST /:principalType/:principalId/changes`, as far as the lock judges it. */
export interface CatalogLockChange {
  op: string;
  segments: readonly string[];
  /** `set`: the value written; `upsertEntry`: the entry written into the array at `segments`. */
  value?: unknown;
}

/**
 * The catalog-lock violations of one change of the atomic changes endpoint: a `set` is judged as a
 * PATCH entry, an `upsertEntry` as the array holding that one entry, a `tombstone` as the tombstone
 * route, and a `rename` under `endpoints` or an MCP section is refused, since a renamed entry
 * would no longer name a catalog endpoint or server. `unset` and `removeEntry` only narrow.
 */
export function getCatalogLockChangeIssues(
  change: CatalogLockChange,
  baseYaml: CatalogBase,
): ConfigOverrideIssue[] {
  const segments = [...change.segments];
  switch (change.op) {
    case 'set':
      return getCatalogLockEntryIssues(segments, change.value, baseYaml);
    case 'upsertEntry':
      return getCatalogLockEntryIssues(segments, [change.value], baseYaml);
    case 'tombstone': {
      const tombstone = getCatalogLockTombstoneIssue(segments.join('.'));
      return tombstone ? [tombstone] : [];
    }
    case 'rename':
      return segments[0] === 'endpoints' ||
        (MCP_SECTIONS as readonly string[]).includes(segments[0])
        ? [issue(segments, 'catalog_field_locked')]
        : [];
    default:
      return [];
  }
}

function checkOverrides(
  overrides: Record<string, unknown>,
  baseYaml: CatalogBase,
): ConfigOverrideIssue[] {
  const issues: ConfigOverrideIssue[] = [];
  collectEnvReferences(overrides, [], issues);
  for (const section of MCP_SECTIONS) {
    if (overrides[section] !== undefined) {
      checkMCPServers(section, overrides[section], baseYaml.mcpServers, issues);
    }
  }

  if (overrides.endpoints === undefined) {
    return issues;
  }
  if (!isRecord(overrides.endpoints)) {
    issues.push(issue(['endpoints'], 'catalog_endpoint_locked'));
    return issues;
  }
  for (const key of Object.keys(overrides.endpoints)) {
    if (key === 'agents') {
      checkAgentsEndpoint(overrides.endpoints.agents, issues);
    } else if (key !== 'custom') {
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
