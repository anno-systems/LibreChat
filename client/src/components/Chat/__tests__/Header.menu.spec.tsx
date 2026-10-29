import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import Header from '../Header';

const mockEndpoint = { current: 'agents' };
const mockSmallScreen = { current: false };
const codeConversation = {
  conversationId: 'convo-1',
  codeEnvironmentMode: 'attached',
  codeWorkspaces: [{ environmentId: 'env', workspaceId: 'ws' }],
};
const mockConversation: { current: Record<string, unknown> | null } = {
  current: codeConversation,
};

jest.mock('react-router-dom', () => ({
  useParams: () => ({ conversationId: 'convo-1' }),
}));
jest.mock('recoil', () => ({
  useRecoilValue: (selector: string) =>
    selector === 'effectiveEndpoint' ? mockEndpoint.current : false,
}));
jest.mock('librechat-data-provider', () => ({
  getConfigDefaults: () => ({ interface: {} }),
  Constants: { NEW_CONVO: 'new' },
  EModelEndpoint: { agents: 'agents' },
  PermissionTypes: { BOOKMARKS: 'bookmarks', MULTI_CONVO: 'multi_convo', TEMPORARY_CHAT: 'temp' },
  Permissions: { USE: 'use' },
  isForcedTemporaryRetention:
    jest.requireActual('librechat-data-provider').isForcedTemporaryRetention,
}));
jest.mock('~/data-provider', () => ({ useGetStartupConfig: () => ({ data: undefined }) }));
jest.mock('~/hooks', () => ({ useHasAccess: () => true }));
jest.mock('~/Providers', () => ({
  useChatContext: () => ({ conversation: mockConversation.current }),
}));
jest.mock('~/hooks/Nav/useDrawerViewport', () => () => mockSmallScreen.current);
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    sidebarExpanded: {},
    effectiveEndpointByIndex: () => 'effectiveEndpoint',
  },
}));
jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | undefined>) => classes.filter(Boolean).join(' '),
}));
jest.mock('../Menus', () => ({
  OpenSidebar: () => null,
  PresetsMenu: () => null,
  NewChat: () => null,
  HeaderMenu: ({ className }: { className?: string }) => (
    <button type="button" data-testid="header-overflow-menu" className={className} />
  ),
}));
jest.mock('../TemporaryChat', () => ({
  TemporaryChat: () => null,
  TemporaryChatIndicator: () => null,
}));
jest.mock('../Trace', () => ({ useTraceControl: () => ({ show: false }) }));
jest.mock('../BackgroundTasks', () => ({
  BackgroundTasksButton: jest.fn(() => <div data-testid="conversation-tasks" />),
}));
jest.mock('../PullRequest', () => ({
  PullRequestChip: jest.fn(() => <div data-testid="conversation-pull-request" />),
}));
jest.mock('../Menus/Endpoints/ModelSelector', () => () => <div data-testid="model-selector" />);
jest.mock('../ExportAndShareMenu', () => () => <button type="button" data-testid="chat-menu" />);
jest.mock('../SubagentThreadLink', () => () => null);
jest.mock('../Menus/BookmarkMenu', () => () => <div data-testid="bookmark-menu" />);
jest.mock('../AddMultiConvo', () => () => <div data-testid="add-multi-convo" />);

/** The left cluster is the element that holds the model selector. */
function leftCluster() {
  return screen.getByTestId('model-selector').parentElement as HTMLElement;
}

describe('Header chat menu (fork: header menu)', () => {
  beforeEach(() => {
    mockSmallScreen.current = false;
    mockConversation.current = codeConversation;
  });

  test('puts the "…" menu in the left cluster, right after the header icons', () => {
    render(<Header />);
    const cluster = leftCluster();
    const menu = screen.getByTestId('header-chat-menu');

    expect(cluster).toContainElement(screen.getByTestId('chat-menu'));
    expect(menu.parentElement).toBe(cluster);
    expect(screen.getByTestId('add-multi-convo').parentElement?.nextElementSibling).toBe(menu);
    expect(screen.getByTestId('chat-menu').parentElement).toHaveClass('flex');
    expect(screen.getByTestId('header-overflow-menu')).toHaveClass('hidden');
  });

  test('keeps the menu out of the right cluster', () => {
    render(<Header />);
    const right = screen.getByTestId('conversation-tasks').parentElement as HTMLElement;

    expect(right).not.toContainElement(screen.getByTestId('chat-menu'));
    expect(right).not.toContainElement(screen.getByTestId('header-overflow-menu'));
  });

  test('shows the overflow menu in the same place on small screens', () => {
    mockSmallScreen.current = true;
    render(<Header />);
    const menu = screen.getByTestId('header-chat-menu');

    expect(leftCluster()).toContainElement(menu);
    expect(screen.getByTestId('header-overflow-menu')).not.toHaveClass('hidden');
    expect(screen.getByTestId('chat-menu').parentElement).toHaveClass('hidden');
  });
});
