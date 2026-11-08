/**
 * routes/integration.routes.ts
 * -----------------------------
 * Route definitions for /api/integrations — explicit consent records for
 * ADDITIONAL (non-login) Google scopes (Milestone 3).
 *
 * SECURITY: `requireAuth` is mounted at the router level; handlers scope
 * everything to `req.auth.userId` (+ RLS). Scope values are validated
 * against the shared allow-list — login scopes can never be recorded
 * here, and recording a grant never calls a Google API.
 *
 * Endpoints:
 *   GET    /api/integrations             list this user's grants
 *   POST   /api/integrations             record explicit consent (upsert)
 *   DELETE /api/integrations/:integration  revoke (idempotent; 404 when
 *                                         never granted)
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  listIntegrationsHandler,
  grantIntegrationHandler,
  revokeIntegrationHandler,
} from '../controllers/integration.controller.js';

const router = Router();

// All integration routes require authentication.
router.use(requireAuth);

router.get('/', listIntegrationsHandler);
router.post('/', grantIntegrationHandler);
router.delete('/:integration', revokeIntegrationHandler);

export default router;
