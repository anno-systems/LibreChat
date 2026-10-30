import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys, MutationKeys, dataService } from 'librechat-data-provider';
import type { TConversationModelMigrationResponse } from 'librechat-data-provider';

const isSavedConversation = (conversationId: string) =>
  conversationId !== '' &&
  conversationId !== Constants.NEW_CONVO &&
  conversationId !== Constants.PENDING_CONVO &&
  conversationId !== Constants.SEARCH;

/** Fork: the conversation's unseen model migration notice; read once per conversation. */
export const useConversationModelMigrationQuery = (conversationId: string) =>
  useQuery<TConversationModelMigrationResponse>(
    [QueryKeys.conversationModelMigration, conversationId],
    () => dataService.getConversationModelMigration(conversationId),
    {
      enabled: isSavedConversation(conversationId),
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
    },
  );

/** Fork: marks a conversation's notice as seen, so it is not shown again. */
export const useClearConversationModelMigration = () => {
  const queryClient = useQueryClient();
  return useMutation(
    [MutationKeys.clearConversationModelMigration],
    (conversationId: string) => dataService.clearConversationModelMigration(conversationId),
    {
      onSuccess: (_data, conversationId) => {
        queryClient.setQueryData<TConversationModelMigrationResponse>(
          [QueryKeys.conversationModelMigration, conversationId],
          { modelMigration: null },
        );
      },
    },
  );
};

/**
 * Fork: marks an agent's notice as seen by its editor. The agent's cached queries stay as they
 * are: new data would reset the builder's form; `useOneTimeNotice` keeps a cached copy from
 * showing the notice again.
 */
export const useClearAgentModelMigration = () =>
  useMutation([MutationKeys.clearAgentModelMigration], (agentId: string) =>
    dataService.clearAgentModelMigration(agentId),
  );
