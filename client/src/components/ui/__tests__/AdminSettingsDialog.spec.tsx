import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen } from '@testing-library/react';
import MemoriesAdminSettings from '~/components/SidePanel/Memories/AdminSettings';
import MCPAdminSettings from '~/components/SidePanel/MCPBuilder/MCPAdminSettings';
import AgentsAdminSettings from '~/components/SidePanel/Agents/AdminSettings';
import PromptsAdminSettings from '~/components/Prompts/buttons/AdminSettings';
import SkillsAdminSettings from '~/components/Skills/buttons/AdminSettings';

const mockMutate = jest.fn();
const mockSelectedRole = { current: 'USER' };
const mockDefaultValues = { USE: true };

jest.mock('@ariakit/react', () => ({
  MenuButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: { role: 'ADMIN' } }),
  useRoleSelector: () => ({
    selectedRole: mockSelectedRole.current,
    isSelectedCustomRole: false,
    isCustomRoleLoading: false,
    isCustomRoleError: false,
    defaultValues: mockDefaultValues,
    roleDropdownItems: [{ label: 'USER', onClick: jest.fn() }],
  }),
}));

jest.mock('~/data-provider', () => {
  const mutation = () => ({ mutate: mockMutate, isLoading: false });
  return {
    useUpdateAgentPermissionsMutation: mutation,
    useUpdateSkillPermissionsMutation: mutation,
    useUpdatePromptPermissionsMutation: mutation,
    useUpdateMemoryPermissionsMutation: mutation,
    useUpdateMCPServersPermissionsMutation: mutation,
  };
});

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  DropdownPopup: ({ trigger, items }: { trigger: React.ReactNode; items: { label: string }[] }) => (
    <div>
      {trigger}
      <ul data-testid="role-options">
        {items.map((item) => (
          <li key={item.label}>{item.label}</li>
        ))}
      </ul>
    </div>
  ),
  useToastContext: () => ({ showToast: jest.fn() }),
}));

describe('admin settings buttons (fork: section names)', () => {
  beforeEach(() => {
    mockSelectedRole.current = 'USER';
  });

  it.each([
    ['agents', AgentsAdminSettings, 'com_ui_manage_agents'],
    ['skills', SkillsAdminSettings, 'com_ui_manage_skills'],
    ['prompts', PromptsAdminSettings, 'com_ui_manage_prompts'],
    ['memories', MemoriesAdminSettings, 'com_ui_manage_memories'],
    ['MCP servers', MCPAdminSettings, 'com_ui_manage_mcp_servers'],
  ])('names the %s button after what it manages', (_name, Component, key) => {
    render(<Component />);

    expect(screen.getByRole('button', { name: key })).toHaveTextContent(key);
    expect(screen.queryByText('com_ui_admin_settings')).not.toBeInTheDocument();
  });
});

describe('AdminSettingsDialog (fork: admin lockout guard)', () => {
  it('offers only the roles the selector gives it, without ADMIN', () => {
    render(<AgentsAdminSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_manage_agents' }));

    expect(screen.getByTestId('role-options')).toHaveTextContent('USER');
    expect(screen.getByTestId('role-options')).not.toHaveTextContent('ADMIN');
  });

  it('shows no librechat.yaml warning or documentation link', () => {
    mockSelectedRole.current = 'ADMIN';
    render(<PromptsAdminSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_manage_prompts' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).not.toHaveTextContent('com_ui_admin_access_warning');
    expect(dialog.querySelector('a[href*="librechat"]')).toBeNull();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
