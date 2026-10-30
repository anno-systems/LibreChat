const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { admin: handlers, orphans } = require('~/server/services/modelMigration');
const { requireJwtAuth } = require('~/server/middleware');

/** Fork: model migrations and redirects within the caller's tenant (`packages/api/src/migration`). */
const router = express.Router();

const read = requireCapability(SystemCapabilities.READ_CONFIGS);
const manage = requireCapability(SystemCapabilities.MANAGE_CONFIGS);

router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN));
router.get('/redirects', read, handlers.listRedirects);
router.delete('/redirects/:id', manage, handlers.deleteRedirect);
router.post('/usage', read, handlers.usage);
router.get('/orphans', read, orphans.admin);
router.post('/migrations/preview', read, handlers.preview);
router.post('/migrations', manage, handlers.migrate);

module.exports = router;
