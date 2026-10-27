import type { MCPOptions } from 'librechat-data-provider';
import type { ParsedServerConfig } from '~/mcp/types';

/**
 * Per-scope MCP server switch (fork). A config document (tenant, group or role
 * override) that sets `mcpServers.<name>.enabled: false` hides the server from
 * that scope. Only an explicit `false` counts, so an absent field keeps
 * upstream's behaviour.
 */
export function isMCPServerDisabled(config: MCPOptions | ParsedServerConfig | undefined): boolean {
  return (config as { enabled?: unknown } | undefined)?.enabled === false;
}

/**
 * The entry `ensureConfigServers` returns for a disabled server instead of an
 * inspected config: it is never inspected or connected, and only tells
 * `getAllServerConfigs` / `getServerConfig` to leave the name out.
 */
export function toDisabledServerMarker(rawConfig: MCPOptions): ParsedServerConfig {
  return { ...rawConfig, enabled: false } as ParsedServerConfig;
}

/**
 * Fork (MCP pricing): tells whether a priced platform server is off for the caller's tenant
 * because the tenant has not subscribed to it. It must answer from memory: it runs on every
 * resolution of a request's MCP servers.
 */
export type MCPServerBillingGate = (serverName: string) => boolean;

/**
 * Whether a config-tier entry hides the server from its scope: an explicit `enabled: false`, or
 * a price the tenant has not agreed to. Without a gate, only the switch counts.
 */
export function isMCPServerSwitchedOff(
  serverName: string,
  config: MCPOptions | ParsedServerConfig | undefined,
  isUnpaid?: MCPServerBillingGate,
): boolean {
  return isMCPServerDisabled(config) || isUnpaid?.(serverName) === true;
}
