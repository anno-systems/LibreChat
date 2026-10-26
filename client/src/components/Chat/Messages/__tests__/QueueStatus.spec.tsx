import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider, createStore } from 'jotai';
import { act, render, screen } from '@testing-library/react';
import type { TQueueStatusEvent } from 'librechat-data-provider';
import { queueStatusFamily } from '~/components/Chat/Messages/queue';
import QueueStatus from '~/components/Chat/Messages/QueueStatus';

function renderStatus(status: TQueueStatusEvent | null) {
  const jotaiStore = createStore();
  jotaiStore.set(queueStatusFamily('convo-1'), status);
  render(
    <RecoilRoot>
      <Provider store={jotaiStore}>
        <QueueStatus conversationId="convo-1" />
      </Provider>
    </RecoilRoot>,
  );
  return jotaiStore;
}

describe('QueueStatus', () => {
  it('tells the user the reply is queued, where, and that it will be sent automatically', () => {
    renderStatus({ queued: true, position: 3, reason: 'provider_busy' });

    const line = screen.getByRole('status');
    expect(line).toHaveTextContent(
      'High demand: your message is queued (position 3) and will be sent automatically.',
    );
  });

  it('names a provider rate limit as the reason', () => {
    renderStatus({ queued: true, position: 1, reason: 'rate_limited' });

    expect(screen.getByRole('status')).toHaveTextContent(/asked us to slow down.*position 1/);
  });

  it('follows the position and disappears once the turn is admitted', () => {
    const jotaiStore = renderStatus({ queued: true, position: 2, reason: 'provider_busy' });
    expect(screen.getByRole('status')).toHaveTextContent('position 2');

    act(() => {
      jotaiStore.set(queueStatusFamily('convo-1'), {
        queued: true,
        position: 1,
        reason: 'provider_busy',
      });
    });
    expect(screen.getByRole('status')).toHaveTextContent('position 1');

    act(() => {
      jotaiStore.set(queueStatusFamily('convo-1'), null);
    });
    expect(screen.queryByTestId('queue-status')).not.toBeInTheDocument();
  });

  it('renders nothing for another conversation or a cleared status', () => {
    renderStatus({ queued: false });
    expect(screen.queryByTestId('queue-status')).not.toBeInTheDocument();
  });
});
