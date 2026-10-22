import { adminLoginFailureUrl, hasSecondFactor, requiresAdminMfa } from './mfa';

describe('admin login second factor', () => {
  it('is required only when OPENID_ADMIN_REQUIRE_MFA is true', () => {
    expect(requiresAdminMfa({ OPENID_ADMIN_REQUIRE_MFA: 'true' })).toBe(true);
    expect(requiresAdminMfa({ OPENID_ADMIN_REQUIRE_MFA: ' TRUE ' })).toBe(true);
    expect(requiresAdminMfa({ OPENID_ADMIN_REQUIRE_MFA: 'false' })).toBe(false);
    expect(requiresAdminMfa({})).toBe(false);
  });

  it('recognizes second factors in the amr claim', () => {
    expect(hasSecondFactor({ amr: ['pwd', 'mfa'] })).toBe(true);
    expect(hasSecondFactor({ amr: ['otp'] })).toBe(true);
    expect(hasSecondFactor({ amr: ['passkey'] })).toBe(true);
    expect(hasSecondFactor({ amr: ['pwd'] })).toBe(false);
    expect(hasSecondFactor({ amr: 'mfa' })).toBe(false);
    expect(hasSecondFactor({})).toBe(false);
    expect(hasSecondFactor(undefined)).toBe(false);
  });

  it('names the refusal for the admin panel', () => {
    const base = 'https://admin.example.com/auth/openid/callback';
    expect(new URL(adminLoginFailureUrl(base, 'mfa_required')).searchParams.get('error')).toBe(
      'mfa_required',
    );
    expect(
      new URL(adminLoginFailureUrl(base, 'Authentication failed')).searchParams.get('error'),
    ).toBe('auth_failed');
    expect(adminLoginFailureUrl(base, undefined).startsWith(`${base}?error=auth_failed`)).toBe(
      true,
    );
  });
});
