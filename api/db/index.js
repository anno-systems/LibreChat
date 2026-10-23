const mongoose = require('mongoose');
const { createModels, runAsSystem } = require('@librechat/data-schemas');
const { connectDb } = require('./connect');

// createModels MUST run before requiring indexSync.
// indexSync.js captures mongoose.models.Message and mongoose.models.Conversation
// at module load time. If those models are not registered first, all MeiliSearch
// sync operations will silently fail on every startup.
createModels(mongoose);

const syncIndexes = require('./indexSync');

/**
 * Fork: the sync reads every tenant's messages and conversations, which strict tenant isolation
 * (`TENANT_ISOLATION_STRICT`) refuses outside the system context.
 */
const indexSync = () => runAsSystem(syncIndexes);

module.exports = { connectDb, indexSync };
