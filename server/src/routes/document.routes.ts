/**
 * routes/document.routes.ts
 * -------------------------
 * Knowledge Base endpoints (Milestone 5 — additive).
 *
 * SECURITY: `requireAuth` runs first on every route, so unauthenticated
 * requests are rejected before any multipart body is parsed or any storage
 * key is touched. Upload and search have per-user, per-instance rate limits.
 *
 * Route order note: `/search` is declared before `/:id` so it can never be
 * shadowed by the id route.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { documentUploadMiddleware } from '../middleware/upload.middleware.js';
import { uploadRateLimiter } from '../middleware/rate-limit.middleware.js';
import {
  downloadDocumentHandler,
  deleteDocumentHandler,
  getDocumentHandler,
  listDocumentChunksHandler,
  listDocumentsHandler,
  renameDocumentHandler,
  retryDocumentHandler,
  uploadDocumentHandler,
  viewDocumentHandler,
} from '../controllers/document.controller.js';

const router = Router();

// Authentication is enforced for every Knowledge Base route.
router.use(requireAuth);

router.get('/', listDocumentsHandler);
router.post('/', uploadRateLimiter, documentUploadMiddleware(), uploadDocumentHandler);

router.get('/:id', getDocumentHandler);
router.patch('/:id', renameDocumentHandler);
router.delete('/:id', deleteDocumentHandler);
router.post('/:id/retry', retryDocumentHandler);
router.get('/:id/view', viewDocumentHandler);
router.get('/:id/content', downloadDocumentHandler);
router.get('/:id/chunks', listDocumentChunksHandler);

export default router;
