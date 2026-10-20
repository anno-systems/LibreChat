import { getTenantId } from '@librechat/data-schemas';
import { openIdGroupsOf, syncOpenIdGroups } from './groups';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const ZITADEL = { OPENID_GROUPS_CLAIM: 'urn:zitadel:iam:user:metadata.idp_groups' };
const metadata = (value: unknown) => ({
  iss: 'https://auth.example.com',
  'urn:zitadel:iam:user:metadata': {
    idp_groups: Buffer.from(JSON.stringify(value)).toString('base64'),
  },
});

describe('openIdGroupsOf', () => {
  it('reads groups a broker passes on as base64 JSON metadata, owned by their provider', () => {
    expect(
      openIdGroupsOf(metadata({ idp: '3959', groups: ['g-sales', 'g-legal'] }), ZITADEL),
    ).toEqual({
      scope: '3959',
      groups: [{ id: 'g-sales' }, { id: 'g-legal' }],
    });
  });

  it("reads a provider's own groups claim, owned by the issuer or the configured scope", () => {
    const claims = { iss: 'https://login.microsoftonline.com/t/v2.0', groups: ['a', 'a', 'b'] };
    expect(openIdGroupsOf(claims, { OPENID_GROUPS_CLAIM: 'groups' })).toEqual({
      scope: 'https://login.microsoftonline.com/t/v2.0',
      groups: [{ id: 'a' }, { id: 'b' }],
    });
    expect(
      openIdGroupsOf(claims, { OPENID_GROUPS_CLAIM: 'groups', OPENID_GROUPS_SCOPE: 'entra' }),
    ).toEqual({ scope: 'entra', groups: [{ id: 'a' }, { id: 'b' }] });
  });

  it('treats an empty list as no groups, and anything unusable as unknown', () => {
    expect(openIdGroupsOf(metadata({ idp: 'x', groups: [] }), ZITADEL)).toEqual({
      scope: 'x',
      groups: [],
    });
    expect(openIdGroupsOf({ iss: 'i' }, ZITADEL)).toBeNull();
    expect(openIdGroupsOf(metadata({ groups: ['a'] }), ZITADEL)).toBeNull();
    expect(openIdGroupsOf(metadata({ idp: 'x', groups: 'a' }), ZITADEL)).toBeNull();
    expect(
      openIdGroupsOf({ 'urn:zitadel:iam:user:metadata': { idp_groups: '%%%' } }, ZITADEL),
    ).toBeNull();
    expect(openIdGroupsOf({ groups: ['a'] }, {})).toBeNull();
    expect(openIdGroupsOf({ groups: ['a'] }, { OPENID_GROUPS_CLAIM: 'groups' })).toBeNull();
  });

  it('drops values that are not group ids', () => {
    const found = openIdGroupsOf(
      { iss: 'i', groups: ['ok', '', 42, 'x'.repeat(300), { id: 'y' }] },
      { OPENID_GROUPS_CLAIM: 'groups' },
    );
    expect(found?.groups).toEqual([{ id: 'ok' }]);
  });
});

describe('syncOpenIdGroups', () => {
  it("syncs in the user's tenant", async () => {
    const seen: unknown[] = [];
    const deps = {
      syncExternalGroupMemberships: jest.fn(async (params: unknown) => {
        seen.push([params, getTenantId()]);
        return { joined: 1, left: 0 };
      }),
    };

    await syncOpenIdGroups(
      deps,
      { _id: 'u1', tenantId: 'tenant-a' },
      metadata({ idp: '3959', groups: ['g-sales'] }),
      ZITADEL,
    );

    expect(seen).toEqual([
      [{ userId: 'u1', scope: '3959', groups: [{ id: 'g-sales' }] }, 'tenant-a'],
    ]);
  });

  it('leaves memberships alone without usable groups and survives a failed sync', async () => {
    const deps = { syncExternalGroupMemberships: jest.fn() };
    await syncOpenIdGroups(deps, { _id: 'u1' }, { iss: 'i' }, ZITADEL);
    expect(deps.syncExternalGroupMemberships).not.toHaveBeenCalled();

    deps.syncExternalGroupMemberships.mockRejectedValueOnce(new Error('db down'));
    await expect(
      syncOpenIdGroups(deps, { _id: 'u1' }, metadata({ idp: 'x', groups: ['g'] }), ZITADEL),
    ).resolves.toBeUndefined();
  });
});
