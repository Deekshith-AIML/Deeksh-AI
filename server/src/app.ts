/**
 * app.ts
 * ------
 * Express application assembly (no `listen` here — see server.ts).
 *
 * Splitting construction from startup lets the test suite import the exact
 * app under test with supertest without opening a port.
 *
 * Middleware order matters:
 *   1. CORS        — decide which origins may call us
 *   2. JSON parser — bounded body size
 *   3. Logging     — development only
 *   4. /health     — unauthenticated liveness probe (no user data)
 *   5. Routes      — each mounts requireAuth as its first middleware
 *   6. 404         — unmatched routes
 *   7. Error handler — must be last (4-arg fn)
 */

import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import cors from 'cors';
import chatRoutes from './routes/chat.routes.js';
import taskRoutes from './routes/task.routes.js';
import reminderRoutes from './routes/reminder.routes.js';
import meRoutes from './routes/me.routes.js';
import integrationRoutes from './routes/integration.routes.js';
import memoryRoutes from './routes/memory.routes.js';
import { AuthError } from './services/auth.service.js';
import { AiServiceError } from './services/ai.service.js';

// ---------------------------------------------------------------------------
// App initialization
// ---------------------------------------------------------------------------

export function createApp(): Express {
  const app: Express = express();

  // -------------------------------------------------------------------------
  // Global middleware
  // -------------------------------------------------------------------------

  /**
   * CORS configuration.
   * - `CORS_ORIGIN` may be a comma-separated list of allowed origins.
   * - Secure default: the Next.js dev origin. `*` must now be opted into
   *   explicitly (CORS_ORIGIN=*) — it is never assumed.
   * - Credentials are not used (bearer tokens in headers), so `*` with
   *   credentials is never a combination we enable.
   */
  const corsOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
    : ['http://localhost:3000'];

  app.use(
    cors({
      origin: corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      // `x-user-id` intentionally NOT allowed: it is no longer a trusted
      // (or even read) identity vector.
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );

  // Parse JSON request bodies (limit 1mb to prevent abuse).
  app.use(express.json({ limit: '1mb' }));

  // Request logging only for local development (silent in tests/production).
  if (process.env.NODE_ENV === 'development') {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
      next();
    });
  }

  // -------------------------------------------------------------------------
  // Health check (unauthenticated, returns no user data)
  // -------------------------------------------------------------------------

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
  });

  // -------------------------------------------------------------------------
  // API routes (authentication is enforced inside each router)
  // -------------------------------------------------------------------------

  app.use('/api/chat', chatRoutes);
  app.use('/api/tasks', taskRoutes);
  app.use('/api/reminders', reminderRoutes);
  app.use('/api/me', meRoutes);
  app.use('/api/integrations', integrationRoutes);
  app.use('/api/memories', memoryRoutes);

  // 404 handler for unmatched routes.
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
  });

  // -------------------------------------------------------------------------
  // Centralized error handler (must have 4 args for Express to treat it
  // as an error handler).
  // -------------------------------------------------------------------------
  //
  // Sanitization rules:
  // - Client-caused errors (<500): their messages were authored for clients
  //   (Zod/Auth/validation), so they are returned as-is.
  // - AiServiceError sets `expose = true` because its messages are already
  //   generic and safe.
  // - Everything else (5xx): a generic message is returned; the real error
  //   (which may contain SQL/AI-provider internals) is logged server-side only.

  app.use((err: Error & { statusCode?: number; expose?: boolean; details?: unknown }, _req: Request, res: Response, _next: NextFunction) => {
    const statusCode = err.statusCode ?? 500;
    const isServerError = statusCode >= 500;
    const canExpose = err.expose === true || !isServerError;

    const payload: { error: string; details?: unknown } = {
      error: canExpose && err.message ? err.message : 'Internal server error',
    };
    // Zod/validation details are safe + useful for clients.
    if (err.details) payload.details = err.details;

    if (process.env.NODE_ENV !== 'production') {
      console.error(`[ERROR] ${statusCode} ${err.stack ?? err.message}`);
    } else if (isServerError) {
      console.error(`[ERROR] ${statusCode} ${err.name}: ${err.message}`);
    }

    res.status(statusCode).json(payload);
  });

  return app;
}

/** Pre-built app for `server.ts` and for tests. */
const app = createApp();

export default app;
