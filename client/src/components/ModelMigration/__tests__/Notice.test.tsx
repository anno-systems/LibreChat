import React from 'react';
import { Provider as JotaiProvider } from 'jotai';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentModelMigrationNotice, ConversationModelMigrationNotice } from '..';
import type { TModelMigrationNotice } from 'librechat-data-provider';

const mockGet = jest.fn();
const mockClearConversation = jest.fn();
const mockClearAgent = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getConversationModelMigration: (...args: unknown[]) => mockGet(...args),
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
  from: { endpoint: 'Mistral', model: 'mistral-large-2407' },
  to: { endpoint: 'Mistral', model: 'mistral-large-2411' },
  at: '2026-10-30T10:00:00.000Z',
};
const text = 'com_ui_model_migrated: mistral-large-2407 -> mistral-large-2411';

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
  mockClearConversation.mockReset().mockResolvedValue(undefined);
  mockClearAgent.mockReset().mockResolvedValue(undefined);
});

describe('ConversationModelMigrationNotice', () => {
  it('shows the notice once, marks it seen and can be dismissed', async () => {
    mockGet.mockResolvedValue({ modelMigration: notice });
    const view = renderWith(<ConversationModelMigrationNotice conversationId="c1" />);
    expect(await screen.findByRole('status')).toHaveTextContent(text);
    await waitFor(() => expect(mockClearConversation).toHaveBeenCalledWith('c1'));
    expect(mockClearConversation).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();

    view.rerender(<ConversationModelMigrationNotice key="again" conversationId="c1" />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(mockClearConversation).toHaveBeenCalledTimes(1);
  });

  it('renders nothing without a notice, on failure or for a new chat', async () => {
    mockGet.mockResolvedValueOnce({ modelMigration: null });
    renderWith(<ConversationModelMigrationNotice conversationId="c2" />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('c2'));
    expect(screen.queryByRole('status')).toBeNull();

    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGet.mockRejectedValueOnce(new Error('offline'));
    renderWith(<ConversationModelMigrationNotice conversationId="c3" />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('c3'));
    expect(screen.queryByRole('status')).toBeNull();
    quiet.mockRestore();

    renderWith(<ConversationModelMigrationNotice conversationId="new" />);
    expect(mockGet).not.toHaveBeenCalledWith('new');
    expect(mockClearConversation).not.toHaveBeenCalled();
  });
});

describe('AgentModelMigrationNotice', () => {
  it('shows the agent notice to the editor once and marks it seen', async () => {
    renderWith(<AgentModelMigrationNotice agentId="agent_1" notice={notice} />);
    expect(screen.getByRole('status')).toHaveTextContent(text);
    await waitFor(() => expect(mockClearAgent).toHaveBeenCalledWith('agent_1'));
  });

  it('renders nothing for an agent without a notice', () => {
    renderWith(<AgentModelMigrationNotice agentId="agent_2" />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(mockClearAgent).not.toHaveBeenCalled();
  });
});
