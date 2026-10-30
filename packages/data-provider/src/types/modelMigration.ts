/** Fork: a model as a migration names it. */
export type TModelRef = { endpoint: string; model: string };

/**
 * Fork: a model migration that moved a conversation or agent to another model, shown once as
 * "Now runs on X instead of Y" (`packages/api/src/migration`).
 */
export type TModelMigrationNotice = {
  id: string;
  from: TModelRef;
  to: TModelRef;
  /** ISO date of the migration. */
  at: string;
};

export type TConversationModelMigrationResponse = {
  modelMigration: TModelMigrationNotice | null;
};
