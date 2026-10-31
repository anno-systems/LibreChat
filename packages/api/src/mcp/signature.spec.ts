import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import type { MCPApprovalClaims } from './signature';
import {
  canonicalJson,
  withMCPApproval,
  mcpArgumentDigest,
  approvedToolCallIds,
  loadMCPApprovalSigner,
  MCP_APPROVAL_TTL_MS,
  MCP_APPROVAL_META_KEY,
  createMCPApprovalSigner,
  createApprovalKeyHandler,
} from './signature';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const decode = (token: string) => {
  const [payload, signature] = token.split('.');
  return {
    claims: JSON.parse(Buffer.from(payload!, 'base64url').toString()) as MCPApprovalClaims,
    valid: verify(null, Buffer.from(payload!), publicKey, Buffer.from(signature!, 'base64url')),
  };
};

const user = { openidId: 'sub-1', tenantId: 'tenant-a' };

describe('MCP approvals', () => {
  it('signs the tenant, user, server, tool and argument digest, valid for a short time', () => {
    const signer = createMCPApprovalSigner(privatePem, () => 1_000);
    const token = signer.sign({
      ...{ tenantId: 'tenant-a', subject: 'sub-1' },
      server: 'lexware',
      tool: 'lexware_issue_invoice',
      toolArguments: { b: 1, a: 'x' },
    });

    const { claims, valid } = decode(token);
    expect(valid).toBe(true);
    expect(claims).toEqual(
      expect.objectContaining({
        v: 1,
        tenantId: 'tenant-a',
        subject: 'sub-1',
        server: 'lexware',
        tool: 'lexware_issue_invoice',
        argumentDigest: mcpArgumentDigest({ a: 'x', b: 1 }),
        iat: 1_000,
        exp: 1_000 + MCP_APPROVAL_TTL_MS,
      }),
    );
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(signer.publicKeyPem).toBe(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  });

  it('digests the arguments as the server receives them', () => {
    const sent = { a: 'x', nested: { y: [1, 2], z: null } };
    const expected = createHash('sha256').update(canonicalJson(sent)).digest('hex');
    expect(mcpArgumentDigest({ nested: { z: null, y: [1, 2], gone: undefined }, a: 'x' })).toBe(
      expected,
    );
    expect(canonicalJson({ b: 1, a: [true, 'x'] })).toBe('{"a":[true,"x"],"b":1}');
  });

  it('adds the approval only to an approved call of an OpenID user of a tenant', () => {
    const signer = createMCPApprovalSigner(privatePem);
    const base = { 'librechat/context': { model: 'm' } };
    const input = { signer, user, server: 's', tool: 't', toolArguments: {} };

    const approved = withMCPApproval(base, { ...input, approved: true });
    expect(approved?.['librechat/context']).toEqual({ model: 'm' });
    expect(decode(approved?.[MCP_APPROVAL_META_KEY] as string).valid).toBe(true);

    expect(withMCPApproval(base, { ...input, approved: false })).toBe(base);
    expect(withMCPApproval(undefined, { ...input, approved: true, signer: undefined })).toBe(
      undefined,
    );
    expect(
      withMCPApproval(base, { ...input, approved: true, user: { tenantId: 'tenant-a' } }),
    ).toBe(base);
  });

  it('reads the approved tool calls from the resume decisions', () => {
    const ids = approvedToolCallIds([
      { tool_call_id: 'a', decision: 'approve' },
      { tool_call_id: 'b', decision: 'edit', editedArguments: {} },
      { tool_call_id: 'c', decision: 'reject' },
      { tool_call_id: 'd', decision: 'respond' },
      null,
    ]);
    expect([...ids]).toEqual(['a', 'b']);
    expect(approvedToolCallIds(undefined).size).toBe(0);
  });

  it('loads the key from the environment, as PEM or base64', () => {
    expect(loadMCPApprovalSigner({})).toBeUndefined();
    const fromPem = loadMCPApprovalSigner({ MCP_APPROVAL_PRIVATE_KEY: privatePem });
    const fromBase64 = loadMCPApprovalSigner({
      MCP_APPROVAL_PRIVATE_KEY: Buffer.from(privatePem).toString('base64'),
    });
    expect(fromBase64?.publicKeyPem).toBe(fromPem?.publicKeyPem);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(() => loadMCPApprovalSigner({ MCP_APPROVAL_PRIVATE_KEY: rsa })).toThrow(/Ed25519/);
  });

  it('publishes the public key, or 404 without one', () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    createApprovalKeyHandler(undefined)({} as never, res as never);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'approval_unconfigured' });

    const signer = createMCPApprovalSigner(privatePem);
    const ok = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    createApprovalKeyHandler(signer)({} as never, ok as never);
    expect(ok.json).toHaveBeenCalledWith({ algorithm: 'Ed25519', publicKey: signer.publicKeyPem });
  });
});
