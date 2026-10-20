import { Constants, isEphemeralAgentId, stripAgentIdSuffix } from 'librechat-data-provider';

/** `_meta` key under which a tool call carries LibreChat's call context (fork: MCP call context). */
export const MCP_CALL_CONTEXT_META_KEY = 'librechat/context';

/** What LibreChat asserts about the turn behind a tool call. Not signed: servers record it. */
export interface MCPCallContext {
  model?: string;
  agentId?: string;
  conversationId?: string;
  messageId?: string;
}

export interface MCPCallContextInput {
  model?: string | null;
  agentId?: string | null;
  requestBody?: { conversationId?: string | null; messageId?: string | null } | null;
}

function value(raw: string | null | undefined): string | undefined {
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/**
 * The `_meta` of a `tools/call` request for a server that set `callContext: true`, or undefined.
 * Ephemeral agents and new conversations have no stable id, so their ids are left out.
 */
export function buildMCPCallMeta(
  serverConfig: { callContext?: boolean } | null | undefined,
  input: MCPCallContextInput,
): Record<string, MCPCallContext> | undefined {
  if (serverConfig?.callContext !== true) {
    return undefined;
  }
  const rawAgentId = value(input.agentId);
  const agentId =
    rawAgentId && !isEphemeralAgentId(rawAgentId) ? stripAgentIdSuffix(rawAgentId) : undefined;
  const conversationId = value(input.requestBody?.conversationId);
  const context: MCPCallContext = {
    model: value(input.model),
    agentId,
    conversationId: conversationId === Constants.NEW_CONVO ? undefined : conversationId,
    messageId: value(input.requestBody?.messageId),
  };
  const entries = Object.entries(context).filter(([, v]) => v !== undefined);
  return entries.length > 0
    ? { [MCP_CALL_CONTEXT_META_KEY]: Object.fromEntries(entries) as MCPCallContext }
    : undefined;
}
