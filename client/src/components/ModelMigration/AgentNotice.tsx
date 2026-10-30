import { memo, useCallback } from 'react';
import type { TModelMigrationNotice } from 'librechat-data-provider';
import { useClearAgentModelMigration } from '~/data-provider';
import Notice, { useOneTimeNotice } from './Notice';

/** Fork: "Now runs on X instead of Y" in the agent builder of a migrated agent, once. */
function AgentModelMigrationNotice({
  agentId,
  notice,
}: {
  agentId: string;
  notice?: TModelMigrationNotice;
}) {
  const { mutate } = useClearAgentModelMigration();
  const markSeen = useCallback(() => mutate(agentId), [mutate, agentId]);
  const [shown, dismiss] = useOneTimeNotice(`agent:${agentId}`, notice, markSeen);
  if (!shown) return null;
  return <Notice notice={shown} onDismiss={dismiss} className="mb-3" />;
}

export default memo(AgentModelMigrationNotice);
