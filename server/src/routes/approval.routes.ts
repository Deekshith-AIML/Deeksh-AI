/**
 * routes/approval.routes.ts
 * --------------------------
 * Route definitions for /api/approvals (M6 Phase 6).
 *
 * SECURITY: `requireAuth` is mounted at the router level so every approval
 * endpoint (list, details, approve, reject, cancel) requires a verified
 * bearer token before any handler runs. Handlers additionally scope every
 * query/transition to `req.auth.userId`; decision bodies are strictly
 * empty (identity is never read from them).
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  approveHandler,
  cancelHandler,
  getApprovalHandler,
  listApprovalsHandler,
  rejectHandler,
} from '../controllers/approval.controller.js';

const router = Router();

// All approval routes require authentication.
router.use(requireAuth);

router.get('/', listApprovalsHandler);
router.get('/:id', getApprovalHandler);
router.post('/:id/approve', approveHandler);
router.post('/:id/reject', rejectHandler);
router.post('/:id/cancel', cancelHandler);

export default router;
