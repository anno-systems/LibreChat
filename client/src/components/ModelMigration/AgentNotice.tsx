import { memo, useCallback } from 'react';
import { useAgentModelMigrationQuery, useClearAgentModelMigration } from '~/data-provider';
import Notice, { migrationKey, useOneTimeNotice } from './Notice';

/** Fork: "Now runs on X instead of Y" in the builder of a migrated agent, once per user. */
function AgentModelMigrationNotice({ agentId }: { agentId: string }) {
  const { data } = useAgentModelMigrationQuery(agentId);
  const { mutate } = useClearAgentModelMigration();
  const markSeen = useCallback(() => mutate(agentId), [mutate, agentId]);
  const [shown, dismiss] = useOneTimeNotice(migrationKey, data?.modelMigration, markSeen);
  if (!shown) return null;
  return <Notice notice={shown} onDismiss={dismiss} className="mb-3" />;
}

export default memo(AgentModelMigrationNotice);
