import React from 'react';
import { Provider as JotaiProvider } from 'jotai';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentModelMigrationNotice, ChatModelMigrationNotice } from '..';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TModelMigrationNotice } from 'librechat-data-provider';

const mockGet = jest.fn();
const mockGetAgent = jest.fn();
const mockClearConversation = jest.fn();
const mockClearAgent = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getConversationModelMigration: (...args: unknown[]) => mockGet(...args),
      getAgentModelMigration: (...args: unknown[]) => mockGetAgent(...args),
      clearConversationModelMigration: (...args: unknown[]) => mockClearConversation(...args),
      clearAgentModelMigration: (...args: unknown[]) => mockClearAgent(...args),
    },
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}: ${values.from} -> ${values.to}` : key,
}));

const notice: TModelMigrationNotice = {
  id: 'mm_1',
  from: { endpoint: 'Mistral', model: 'mistral-large-2407', label: 'Mistral Large 2' },
  to: { endpoint: 'Mistral', model: 'mistral-large-2411' },
  at: '2026-10-30T10:00:00.000Z',
};
/* Labels where the migration knew them, the model id otherwise. */
const text = 'com_ui_model_migrated: Mistral Large 2 -> mistral-large-2411';

function renderWith(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <JotaiProvider>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </JotaiProvider>
  );
  return render(ui, { wrapper });
}

beforeEach(() => {
  mockGet.mockReset();
  mockGetAgent.mockReset().mockResolvedValue({ modelMigration: null });
  mockClearConversation.mockReset().mockResolvedValue(undefined);
  mockClearAgent.mockReset().mockResolvedValue(undefined);
});

describe('ChatModelMigrationNotice', () => {
  it('shows the notice once, marks it seen and can be dismissed', async () => {
    mockGet.mockResolvedValue({ modelMigration: notice });
    const view = renderWith(<ChatModelMigrationNotice conversationId="c1" />);
    expect(await screen.findByRole('status')).toHaveTextContent(text);
    await waitFor(() => expect(mockClearConversation).toHaveBeenCalledWith('c1'));
    expect(mockClearConversation).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();

    view.rerender(<ChatModelMigrationNotice key="again" conversationId="c1" />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(mockClearConversation).toHaveBeenCalledTimes(1);
  });

  it('renders nothing without a notice, on failure or for a new chat', async () => {
    mockGet.mockResolvedValueOnce({ modelMigration: null });
    renderWith(<ChatModelMigrationNotice conversationId="c2" />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('c2'));
    expect(screen.queryByRole('status')).toBeNull();

    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGet.mockRejectedValueOnce(new Error('offline'));
    renderWith(<ChatModelMigrationNotice conversationId="c3" />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('c3'));
    expect(screen.queryByRole('status')).toBeNull();
    quiet.mockRestore();

    renderWith(<ChatModelMigrationNotice conversationId="new" />);
    expect(mockGet).not.toHaveBeenCalledWith('new');
    expect(mockClearConversation).not.toHaveBeenCalled();
  });
});

describe('ChatModelMigrationNotice with an agent', () => {
  it('shows a migrated agent notice on a new chat and marks it seen for the user', async () => {
    mockGetAgent.mockResolvedValue({ modelMigration: notice });
    renderWith(
      <ChatModelMigrationNotice conversationId="new" endpoint="agents" agentId="agent_1" />,
    );
    expect(await screen.findByRole('status')).toHaveTextContent(text);
    await waitFor(() => expect(mockClearAgent).toHaveBeenCalledWith('agent_1'));
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('prefers the conversation notice and clears both when they are one migration', async () => {
    mockGet.mockResolvedValue({ modelMigration: notice });
    mockGetAgent.mockResolvedValue({ modelMigration: notice });
    renderWith(
      <ChatModelMigrationNotice conversationId="c9" endpoint="agents" agentId="agent_1" />,
    );
    expect(await screen.findByRole('status')).toHaveTextContent(text);
    await waitFor(() => expect(mockClearConversation).toHaveBeenCalledWith('c9'));
  });
});

describe('AgentModelMigrationNotice', () => {
  it('shows the agent notice in the builder once and marks it seen', async () => {
    mockGetAgent.mockResolvedValue({ modelMigration: notice });
    renderWith(<AgentModelMigrationNotice agentId="agent_1" />);
    expect(await screen.findByRole('status')).toHaveTextContent(text);
    await waitFor(() => expect(mockClearAgent).toHaveBeenCalledWith('agent_1'));
  });

  it('renders nothing for an agent without a notice', async () => {
    renderWith(<AgentModelMigrationNotice agentId="agent_2" />);
    await waitFor(() => expect(mockGetAgent).toHaveBeenCalledWith('agent_2'));
    expect(screen.queryByRole('status')).toBeNull();
    expect(mockClearAgent).not.toHaveBeenCalled();
  });
});
