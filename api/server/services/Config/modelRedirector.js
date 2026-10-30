const {
  withAgentRedirect,
  validateAgentModel,
  createModelRedirector,
  createRequestRedirect,
} = require('@librechat/api');
const db = require('~/models');

/** Fork: runtime model redirects from the in-memory copy of model migrations (`packages/api/src/migration`). */
const redirector = createModelRedirector({ getModelRedirects: () => db.getModelRedirects() });

module.exports = {
  /** For `augmentConfig`: model specs whose model was migrated name its successor. */
  redirectModelSpecs: redirector.redirectModelSpecs,
  /** Chat route middleware: a request that names a migrated model runs on its successor. */
  redirectRequest: createRequestRedirect(redirector),
  /** `validateAgentModel` after moving the agent to its model's successor, if redirected. */
  validateAgentModel: withAgentRedirect(validateAgentModel, redirector),
};
