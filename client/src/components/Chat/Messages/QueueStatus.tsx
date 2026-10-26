import { memo } from 'react';
import { useAtomValue } from 'jotai';
import { Constants } from 'librechat-data-provider';
import { queueStatusFamily } from './queue';
import { useLocalize } from '~/hooks';

/**
 * Fork: why the pending reply has not started, under it in the footer slot the elapsed timer
 * shares. A polite status region, so a screen reader hears the place change without losing focus.
 */
const QueueStatus = memo(function QueueStatus({
  conversationId,
}: {
  conversationId?: string | null;
}) {
  const localize = useLocalize();
  const status = useAtomValue(queueStatusFamily(conversationId ?? Constants.NEW_CONVO));
  if (status?.queued !== true) {
    return null;
  }
  const position = String(status.position ?? 1);
  return (
    <span role="status" className="text-text-secondary ps-1.5 text-sm" data-testid="queue-status">
      {status.reason === 'rate_limited'
        ? localize('com_ui_provider_queue_rate_limited', { 0: position })
        : localize('com_ui_provider_queue_busy', { 0: position })}
    </span>
  );
});

export default QueueStatus;
