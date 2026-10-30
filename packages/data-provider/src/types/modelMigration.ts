/** Fork: a model as a migration names it. */
export type TModelRef = {
  endpoint: string;
  model: string;
  /** Display name at migration time ("Mistral Large 3"); show `model` without one. */
  label?: string;
};

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

/** The answer for a conversation's or an agent's notice (the agent's per user, 30 days). */
export type TModelMigrationNoticeResponse = {
  modelMigration: TModelMigrationNotice | null;
};
