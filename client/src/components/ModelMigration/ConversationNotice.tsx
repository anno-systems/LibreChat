import { memo, useCallback } from 'react';
import {
  useConversationModelMigrationQuery,
  useClearConversationModelMigration,
} from '~/data-provider';
import Notice, { useOneTimeNotice } from './Notice';

/** Fork: "Now runs on X instead of Y" above the composer of a migrated conversation, once. */
function ConversationModelMigrationNotice({ conversationId }: { conversationId: string }) {
  const { data } = useConversationModelMigrationQuery(conversationId);
  const { mutate } = useClearConversationModelMigration();
  const markSeen = useCallback(() => mutate(conversationId), [mutate, conversationId]);
  const [notice, dismiss] = useOneTimeNotice(
    `conversation:${conversationId}`,
    data?.modelMigration,
    markSeen,
  );
  if (!notice) return null;
  return (
    <Notice
      notice={notice}
      onDismiss={dismiss}
      className="mx-auto mb-2 w-full max-w-3xl xl:max-w-4xl"
    />
  );
}

export default memo(ConversationModelMigrationNotice);
