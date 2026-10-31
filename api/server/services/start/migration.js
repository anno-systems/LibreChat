const mongoose = require('mongoose');
const { logger, runAsSystem, warnOnMissingSearchTokens } = require('@librechat/data-schemas');
const {
  logAgentMigrationWarning,
  logPromptMigrationWarning,
  checkAgentPermissionsMigration,
  checkPromptPermissionsMigration,
} = require('@librechat/api');
const { findRoleByIdentifier } = require('~/models');

/**
 * Check if permissions migrations are needed for shared resources
 * This runs at the end to ensure all systems are initialized
 */
async function checkMigrations() {
  /** Started first so it overlaps the permission checks; it logs its own failures. */
  const searchTokens = warnOnMissingSearchTokens(mongoose.connection);
  try {
    // Fork: it reads every tenant's agents, which TENANT_ISOLATION_STRICT allows only as system.
    const agentMigrationResult = await runAsSystem(() =>
      checkAgentPermissionsMigration({
        mongoose,
        methods: {
          findRoleByIdentifier,
        },
        AgentModel: mongoose.models.Agent,
      }),
    );
    logAgentMigrationWarning(agentMigrationResult);
  } catch (error) {
    logger.error('Failed to check agent permissions migration:', error);
  }
  try {
    const promptMigrationResult = await runAsSystem(() =>
      checkPromptPermissionsMigration({
        mongoose,
        methods: {
          findRoleByIdentifier,
        },
        PromptGroupModel: mongoose.models.PromptGroup,
      }),
    );
    logPromptMigrationWarning(promptMigrationResult);
  } catch (error) {
    logger.error('Failed to check prompt permissions migration:', error);
  }
  await searchTokens;
}

module.exports = {
  checkMigrations,
};
