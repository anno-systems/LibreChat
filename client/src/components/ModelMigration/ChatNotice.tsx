import { memo, useCallback } from 'react';
import { isAgentsEndpoint, isEphemeralAgentId } from 'librechat-data-provider';
import type { TModelMigrationNotice } from 'librechat-data-provider';
import {
  useAgentModelMigrationQuery,
  useClearAgentModelMigration,
  useConversationModelMigrationQuery,
  useClearConversationModelMigration,
} from '~/data-provider';
import Notice, { migrationKey, useOneTimeNotice } from './Notice';

/**
 * Fork: "Now runs on X instead of Y" above the composer, once: for a migrated conversation, or,
 * on any chat with a migrated agent (new chats too) within 30 days of the migration, once per
 * user. A conversation's own notice comes first.
 */
function ChatModelMigrationNotice({
  conversationId,
  endpoint,
  agentId: selectedAgentId,
}: {
  conversationId: string;
  /** The chat's endpoint; only the agents endpoint runs a saved agent. */
  endpoint?: string | null;
  agentId?: string | null;
}) {
  const agentId =
    isAgentsEndpoint(endpoint) && selectedAgentId && !isEphemeralAgentId(selectedAgentId)
      ? selectedAgentId
      : undefined;
  const conversation = useConversationModelMigrationQuery(conversationId);
  const agent = useAgentModelMigrationQuery(agentId);
  const clearConversation = useClearConversationModelMigration().mutate;
  const clearAgent = useClearAgentModelMigration().mutate;
  const own = conversation.data?.modelMigration;
  const markSeen = useCallback(
    (notice: TModelMigrationNotice) => {
      if (own && notice.id === own.id) {
        clearConversation(conversationId);
      }
      if (agentId && agent.data?.modelMigration?.id === notice.id) {
        clearAgent(agentId);
      }
    },
    [own, agentId, agent.data, conversationId, clearConversation, clearAgent],
  );
  const [notice, dismiss] = useOneTimeNotice(
    (shown) => (shown === own ? `conversation:${conversationId}:${shown.id}` : migrationKey(shown)),
    own ?? agent.data?.modelMigration,
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

export default memo(ChatModelMigrationNotice);
