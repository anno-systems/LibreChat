const express = require('express');
const { createBannerResolver, isEnabled } = require('@librechat/api');
const { logger, getTenantId } = require('@librechat/data-schemas');
const optionalJwtAuth = require('~/server/middleware/optionalJwtAuth');
const { getBanner, findActivePlatformBanner } = require('~/models');

/** Fork: the tenant's banner or the platform operator's, whichever started later. */
const currentBanner = createBannerResolver({
  getBanner,
  findActivePlatformBanner,
  ownWithoutTenant: !isEnabled(process.env.TENANT_ISOLATION_STRICT),
});

const router = express.Router();

router.get('/', optionalJwtAuth, async (req, res) => {
  try {
    res.status(200).send(await currentBanner(req.user, req.user?.tenantId ?? getTenantId()));
  } catch (error) {
    logger.error('[getBanner] Error getting banner', error);
    res.status(500).json({ message: 'Error getting banner' });
  }
});

module.exports = router;
