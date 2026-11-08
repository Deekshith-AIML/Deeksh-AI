/**
 * middleware/rate-limit.middleware.ts
 * -----------------------------------
 * Minimal in-process, per-user rate limiting for Knowledge Base routes.
 *
 * Why in-process: the brief forbids Redis and this deployment is a single
 * API process. The limiter is therefore explicitly PER-INSTANCE; a
 * multi-instance deployment needs a shared counter. It is a abuse guard,
 * not a security boundary.
 *
 * Keyed by the VERIFIED user id, so one user cannot exhaust another user's
 * budget, and unauthenticated traffic never reaches it (it is mounted after
 * `requireAuth`).
 */

import type { Request, Response, NextFunction } from 'express';
import { getAuth } from './auth.middleware.js';
import { getDocumentsConfig } from '../config/documents.config.js';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 10_000;

function prune(now: number): void {
  if (buckets.size < MAX_KEYS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitOptions {
  name: string;
  /** Requests allowed per window. Read per call so env changes apply. */
  max: () => number;
  windowMs: number;
}

export function createRateLimiter(options: RateLimitOptions) {
  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const { userId } = getAuth(req);
    const now = Date.now();
    prune(now);

    const key = `${options.name}:${userId}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }

    if (bucket.count >= options.max()) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many document requests. Please slow down.' });
      return;
    }

    bucket.count += 1;
    next();
  };
}

/** Per-user upload limiter (default 10/minute). */
export const uploadRateLimiter = createRateLimiter({
  name: 'documents-upload',
  max: () => getDocumentsConfig().uploadRatePerMin,
  windowMs: 60_000,
});

/** Per-user semantic search limiter (default 60/minute). */
export const searchRateLimiter = createRateLimiter({
  name: 'documents-search',
  max: () => getDocumentsConfig().searchRatePerMin,
  windowMs: 60_000,
});

/** Test hook: clear all counters between tests. */
export function resetRateLimits(): void {
  buckets.clear();
}
