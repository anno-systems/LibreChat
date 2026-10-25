import React from 'react';
import { RecoilRoot } from 'recoil';
import userEvent from '@testing-library/user-event';
import { render, screen, cleanup } from '@testing-library/react';

let mockStartupConfig: { adminPanelURL?: string } | undefined;

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({
    user: { name: 'Ada', email: 'ada@example.com' },
    logout: jest.fn(),
  }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
}));

jest.mock('~/components/Nav/SettingsTabs/General/ArchivedChatsModal', () => ({
  ArchivedChatsModal: () => null,
}));

const mockOpenInNewTab = jest.fn();
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  openInNewTab: (url: string) => mockOpenInNewTab(url),
}));

jest.mock('@librechat/client', () => ({
  GearIcon: (props: React.ComponentProps<'svg'>) => <svg {...props} />,
  DropdownMenuSeparator: () => <hr />,
  Avatar: () => <span />,
}));

import AccountSettings from '../AccountSettings';

const renderMenu = async () => {
  render(
    <RecoilRoot>
      <AccountSettings />
    </RecoilRoot>,
  );
  await userEvent.click(screen.getByTestId('nav-user'));
  await screen.findByTestId('nav-settings');
};

describe('AccountSettings admin panel link', () => {
  afterEach(() => {
    mockStartupConfig = undefined;
    mockOpenInNewTab.mockClear();
    cleanup();
  });

  it('sits directly below Settings and opens the admin app in a new tab', async () => {
    mockStartupConfig = { adminPanelURL: 'https://admin.example.com/?tenant=acme' };
    await renderMenu();

    const item = screen.getByRole('menuitem', { name: 'com_ui_admin_panel' });
    const items = screen.getAllByRole('menuitem');
    const settingsIndex = items.indexOf(screen.getByTestId('nav-settings'));
    expect(items[settingsIndex + 1]).toBe(item);

    await userEvent.click(item);
    expect(mockOpenInNewTab).toHaveBeenCalledWith('https://admin.example.com/?tenant=acme');
  });

  it('is absent when the user has no admin access', async () => {
    mockStartupConfig = {};
    await renderMenu();

    expect(screen.queryByTestId('nav-admin-panel')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_admin_panel')).not.toBeInTheDocument();
  });

  it('is absent while the startup config is loading', async () => {
    await renderMenu();

    expect(screen.queryByTestId('nav-admin-panel')).not.toBeInTheDocument();
  });
});
