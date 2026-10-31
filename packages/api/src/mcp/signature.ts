import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import type { Request, Response } from 'express';
import type { KeyObject } from 'node:crypto';

/**
 * Signed tool approvals (fork). When a user approves a tool call in the chat, LibreChat signs the
 * approval with an Ed25519 key and sends it in the `tools/call` request's `_meta` under
 * `librechat/approval`. A platform MCP server checks it against the public key
 * (`GET /api/platform/mcp/approval-key`) before it runs a tool the user has to confirm, so a call
 * nobody approved is refused even if it reaches the server another way.
 *
 * The approval names the tenant, the user (token subject), the server, the tool and the digest of
 * the exact arguments, expires after {@link MCP_APPROVAL_TTL_MS} and carries a one-time id.
 */
export const MCP_APPROVAL_META_KEY: string = 'librechat/approval';
export const MCP_APPROVAL_TTL_MS: number = 120_000;

export interface MCPApprovalClaims {
  v: 1;
  tenantId: string;
  subject: string;
  server: string;
  tool: string;
  argumentDigest: string;
  /** Issued and expiry times, ms since the epoch. */
  iat: number;
  exp: number;
  jti: string;
}

export interface MCPApprovalInput {
  tenantId: string;
  subject: string;
  server: string;
  tool: string;
  toolArguments: unknown;
}

export interface MCPApprovalSigner {
  sign(input: MCPApprovalInput): string;
  /** The public key as SPKI PEM, for the MCP servers. */
  readonly publicKeyPem: string;
}

/** Code-unit order, as the MCP servers sort keys (not locale order). */
function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** JSON with sorted keys and no undefined values; the MCP servers' `canonicalJson`. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => compareKeys(a, b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 of the arguments as the server receives them: through JSON first (so `undefined` and
 * other values JSON drops or changes come out the same), then in canonical form.
 */
export function mcpArgumentDigest(toolArguments: unknown): string {
  const sent: unknown = JSON.parse(JSON.stringify(toolArguments ?? {}));
  return createHash('sha256').update(canonicalJson(sent)).digest('hex');
}

const base64url = (value: Buffer | string): string => Buffer.from(value).toString('base64url');

/** A signer for an Ed25519 private key in PKCS#8 PEM; throws for any other key. */
export function createMCPApprovalSigner(
  privateKeyPem: string,
  now: () => number = Date.now,
): MCPApprovalSigner {
  const key: KeyObject = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('MCP_APPROVAL_PRIVATE_KEY must be an Ed25519 private key');
  }
  const publicKeyPem = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  return {
    publicKeyPem,
    sign(input) {
      const iat = now();
      const claims: MCPApprovalClaims = {
        v: 1,
        tenantId: input.tenantId,
        subject: input.subject,
        server: input.server,
        tool: input.tool,
        argumentDigest: mcpArgumentDigest(input.toolArguments),
        iat,
        exp: iat + MCP_APPROVAL_TTL_MS,
        jti: randomUUID(),
      };
      const payload = base64url(JSON.stringify(claims));
      return `${payload}.${base64url(sign(null, Buffer.from(payload), key))}`;
    },
  };
}

/**
 * The signer from `MCP_APPROVAL_PRIVATE_KEY` (a PKCS#8 PEM, or that PEM in base64 so it fits one
 * env line), or undefined when it is not set: approvals are then not signed, as upstream.
 */
export function loadMCPApprovalSigner(
  env: Record<string, string | undefined>,
): MCPApprovalSigner | undefined {
  const raw = env.MCP_APPROVAL_PRIVATE_KEY?.trim();
  if (!raw) return undefined;
  const pem = raw.includes('-----BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return createMCPApprovalSigner(pem.replace(/\\n/g, '\n'));
}

export interface MCPApprovalMetaInput {
  signer?: MCPApprovalSigner;
  /** Whether the user approved this tool call in the chat. */
  approved: boolean;
  user?: { openidId?: string | null; tenantId?: string | null } | null;
  server: string;
  tool: string;
  toolArguments: unknown;
}

/**
 * `meta` with a signed approval added when the user approved the call, a signer is configured and
 * the user is an OpenID user of a tenant (the identity the MCP server verifies); else `meta`.
 */
export function withMCPApproval(
  meta: Record<string, unknown> | undefined,
  input: MCPApprovalMetaInput,
): Record<string, unknown> | undefined {
  const subject = input.user?.openidId;
  const tenantId = input.user?.tenantId;
  if (!input.approved || !input.signer || !subject || !tenantId) return meta;
  const approval = input.signer.sign({
    tenantId,
    subject,
    server: input.server,
    tool: input.tool,
    toolArguments: input.toolArguments,
  });
  return { ...(meta ?? {}), [MCP_APPROVAL_META_KEY]: approval };
}

/**
 * The tool call ids a resumed run's user approved, by approve or edit, from the resume request's
 * decisions (already checked against the pending action by the resume route).
 */
export function approvedToolCallIds(decisions: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(decisions)) return ids;
  for (const entry of decisions) {
    const { tool_call_id: id, decision } = (entry ?? {}) as {
      tool_call_id?: unknown;
      decision?: unknown;
    };
    if (typeof id === 'string' && (decision === 'approve' || decision === 'edit')) ids.add(id);
  }
  return ids;
}

/** `GET /api/platform/mcp/approval-key`: the public key, or 404 when approvals are not signed. */
export function createApprovalKeyHandler(
  signer: MCPApprovalSigner | undefined,
): (req: Request, res: Response) => void {
  return (_req: Request, res: Response): void => {
    if (!signer) {
      res.status(404).json({ error: 'approval_unconfigured' });
      return;
    }
    res.json({ algorithm: 'Ed25519', publicKey: signer.publicKeyPem });
  };
}
