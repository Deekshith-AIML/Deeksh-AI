/**
 * controllers/integration.controller.ts
 * -------------------------------------
 * REST handlers for explicit integration consent records (Milestone 3).
 *
 * SECURITY:
 * - Identity comes exclusively from `getAuth(req)` (verified token); all
 *   queries are scoped to that userId by the service (+ RLS underneath).
 * - Request bodies are validated with `grantIntegrationSchema`, which
 *   allow-lists scopes via shared/auth.ts. Unknown scopes → 400.
 * - Recording a grant performs NO Google API calls: it only stores the
 *   user's explicit decision (login never reads these records).
 *
 * Status mapping:
 *   400 invalid payload / unknown scope
 *   401 missing/invalid token (handled by requireAuth)
 *   404 integration never authorized by this user
 */

import type { Request, Response, NextFunction } from 'express';
import { grantIntegrationSchema, integrationParamSchema } from '../../../shared/schemas.js';
import * as integrationService from '../services/integration.service.js';
import { getAuth, getDb } from '../middleware/auth.middleware.js';

/** Map service error codes to HTTP statuses. */
function statusFor(err: integrationService.IntegrationServiceError): number {
  switch (err.code) {
    case integrationService.INTEGRATION_NOT_FOUND:
      return 404;
    default:
      return 500;
  }
}

function handleError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof integrationService.IntegrationServiceError) {
    const status = statusFor(err);
    if (status !== 500) {
      res.status(status).json({ error: err.message });
      return;
    }
  }
  next(err);
}

// ---------------------------------------------------------------------------
// GET /api/integrations
// ---------------------------------------------------------------------------

export async function listIntegrationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const integrations = await integrationService.listIntegrations(db, userId);
    res.status(200).json({ integrations });
  } catch (err) {
    handleError(err, res, next);
  }
}

// ---------------------------------------------------------------------------
// POST /api/integrations  (record explicit consent)
// ---------------------------------------------------------------------------

export async function grantIntegrationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const parsed = grantIntegrationSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid integration payload', details: parsed.error.flatten() });
      return;
    }

    const { grant, created } = await integrationService.grantIntegration(
      db,
      userId,
      parsed.data.integration,
      parsed.data.scopes,
    );
    res.status(created ? 201 : 200).json({ integration: grant, created });
  } catch (err) {
    handleError(err, res, next);
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/integrations/:integration  (revoke — idempotent)
// ---------------------------------------------------------------------------

export async function revokeIntegrationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const params = integrationParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: 'Unknown integration' });
      return;
    }

    const grant = await integrationService.revokeIntegration(
      db,
      userId,
      params.data.integration,
    );
    res.status(200).json({ integration: grant });
  } catch (err) {
    handleError(err, res, next);
  }
}
