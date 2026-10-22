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
