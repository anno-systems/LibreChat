import { act, renderHook } from '@testing-library/react';
import { PermissionTypes, SystemRoles } from 'librechat-data-provider';
import { useRoleSelector } from '../useRoleSelector';

const mockRoleList: { current: { roles: { name: string }[] } | undefined } = {
  current: undefined,
};

jest.mock('~/data-provider', () => ({
  useListRoles: () => ({ data: mockRoleList.current }),
  useGetRole: () => ({ data: null, isLoading: false, isError: false }),
}));

jest.mock('../AuthContext', () => ({
  useAuthContext: () => ({ user: { role: 'ADMIN' }, roles: {} }),
}));

describe('useRoleSelector (fork: admin lockout guard)', () => {
  beforeEach(() => {
    mockRoleList.current = undefined;
  });

  it('never offers the ADMIN role, so an admin cannot lock admins out', () => {
    mockRoleList.current = {
      roles: [{ name: SystemRoles.USER }, { name: SystemRoles.ADMIN }, { name: 'STAFF' }],
    };
    const { result } = renderHook(() => useRoleSelector(PermissionTypes.AGENTS));

    expect(result.current.roleDropdownItems.map((item) => item.label)).toEqual([
      SystemRoles.USER,
      'STAFF',
    ]);
  });

  it('offers only USER before the role list loads', () => {
    const { result } = renderHook(() => useRoleSelector(PermissionTypes.PROMPTS));

    expect(result.current.roleDropdownItems.map((item) => item.label)).toEqual([SystemRoles.USER]);
    expect(result.current.selectedRole).toBe(SystemRoles.USER);
  });

  it('leaves out ADMIN whatever its case', () => {
    mockRoleList.current = { roles: [{ name: 'admin' }, { name: 'STAFF' }] };
    const { result } = renderHook(() => useRoleSelector(PermissionTypes.SKILLS));

    expect(result.current.roleDropdownItems.map((item) => item.label)).toEqual(['STAFF']);
    act(() => result.current.roleDropdownItems[0].onClick());
    expect(result.current.selectedRole).toBe('STAFF');
  });
});
