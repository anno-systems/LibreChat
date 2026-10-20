import { getRoleClaimValues } from './roles';

describe('getRoleClaimValues', () => {
  it('reads arrays, separated strings and objects keyed by role', () => {
    expect(getRoleClaimValues(['a', 'b', 3])).toEqual(['a', 'b']);
    expect(getRoleClaimValues('a, b c')).toEqual(['a', 'b', 'c']);
    expect(getRoleClaimValues({ 'tenant-admin': { 'tenant-a': 'tenant-a.example.com' } })).toEqual([
      'tenant-admin',
    ]);
  });

  it('returns no roles for anything else', () => {
    expect(getRoleClaimValues(undefined)).toEqual([]);
    expect(getRoleClaimValues(null)).toEqual([]);
    expect(getRoleClaimValues(true)).toEqual([]);
  });
});
