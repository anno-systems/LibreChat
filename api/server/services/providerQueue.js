const { createProviderGate, createMemoryQueueStore } = require('@librechat/api');

/**
 * Fork: this process's provider queues (`packages/api/src/queue`), shared by every tenant. The
 * in-memory store serves a single replica; several replicas need a shared store passed here.
 */
const providerGate = createProviderGate({ store: createMemoryQueueStore() });

module.exports = { providerGate };
