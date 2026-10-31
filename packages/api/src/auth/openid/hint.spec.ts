import { applyLoginHint, getLoginHint } from './hint';

describe('getLoginHint', () => {
  it.each([
    ['platform-test@acme.invalid', 'platform-test@acme.invalid'],
    ['  anna.berg@example.com ', 'anna.berg@example.com'],
    ["jürgen_o'neil", "jürgen_o'neil"],
    ['olga', 'olga'],
  ])('accepts %s', (value, expected) => {
    expect(getLoginHint({ login_hint: value })).toBe(expected);
  });

  it.each([
    ['no query', undefined],
    ['no hint', {}],
    ['an empty hint', { login_hint: '  ' }],
    ['a repeated hint', { login_hint: ['a@b.c', 'd@e.f'] }],
    ['a nested object', { login_hint: { $ne: '' } }],
    ['a control character', { login_hint: 'anna\n@example.com' }],
    ['a NUL', { login_hint: 'anna\u0000' }],
    ['spaces inside', { login_hint: 'anna berg' }],
    ['markup', { login_hint: '<script>@x.y' }],
    ['a URL', { login_hint: 'https://evil.example/' }],
    ['a leading symbol', { login_hint: '@admin' }],
    ['a too long hint', { login_hint: `${'a'.repeat(250)}@x.yz` }],
  ])('drops %s', (_name, query) => {
    expect(getLoginHint(query)).toBeUndefined();
  });
});

describe('applyLoginHint', () => {
  it('sets the parameter for a valid hint', () => {
    const params = new URLSearchParams({ scope: 'openid' });
    applyLoginHint(params, { login_hint: 'platform-test@acme.invalid' });
    expect(params.get('login_hint')).toBe('platform-test@acme.invalid');
    expect(params.get('prompt')).toBe('login');
    expect(params.get('scope')).toBe('openid');
  });

  it('leaves the parameters alone without a valid hint', () => {
    const params = new URLSearchParams({ scope: 'openid' });
    applyLoginHint(params, { login_hint: 'a b' });
    applyLoginHint(params, undefined);
    expect(params.has('login_hint')).toBe(false);
    expect(params.has('prompt')).toBe(false);
  });
});
