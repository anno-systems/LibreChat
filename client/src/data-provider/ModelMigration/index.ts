import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys, MutationKeys, dataService } from 'librechat-data-provider';
import type { TModelMigrationNoticeResponse } from 'librechat-data-provider';

const isSavedConversation = (conversationId: string) =>
  conversationId !== '' &&
  conversationId !== Constants.NEW_CONVO &&
  conversationId !== Constants.PENDING_CONVO &&
  conversationId !== Constants.SEARCH;

const noticeQueryOptions = {
  staleTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
} as const;

/** Fork: the conversation's unseen model migration notice; read once per conversation. */
export const useConversationModelMigrationQuery = (conversationId: string) =>
  useQuery<TModelMigrationNoticeResponse>(
    [QueryKeys.conversationModelMigration, conversationId],
    () => dataService.getConversationModelMigration(conversationId),
    { ...noticeQueryOptions, enabled: isSavedConversation(conversationId) },
  );

/** Fork: a migrated agent's notice for the signed-in user (unseen, within 30 days). */
export const useAgentModelMigrationQuery = (agentId: string | null | undefined) =>
  useQuery<TModelMigrationNoticeResponse>(
    [QueryKeys.agentModelMigration, agentId],
    () => dataService.getAgentModelMigration(agentId ?? ''),
    { ...noticeQueryOptions, enabled: Boolean(agentId) },
  );

/** Fork: marks a conversation's notice as seen, so it is not shown again. */
export const useClearConversationModelMigration = () => {
  const queryClient = useQueryClient();
  return useMutation(
    [MutationKeys.clearConversationModelMigration],
    (conversationId: string) => dataService.clearConversationModelMigration(conversationId),
    {
      onSuccess: (_data, conversationId) => {
        queryClient.setQueryData<TModelMigrationNoticeResponse>(
          [QueryKeys.conversationModelMigration, conversationId],
          { modelMigration: null },
        );
      },
    },
  );
};

/** Fork: marks an agent's notice as seen by the signed-in user. */
export const useClearAgentModelMigration = () => {
  const queryClient = useQueryClient();
  return useMutation(
    [MutationKeys.clearAgentModelMigration],
    (agentId: string) => dataService.clearAgentModelMigration(agentId),
    {
      onSuccess: (_data, agentId) => {
        queryClient.setQueryData<TModelMigrationNoticeResponse>(
          [QueryKeys.agentModelMigration, agentId],
          { modelMigration: null },
        );
      },
    },
  );
};
