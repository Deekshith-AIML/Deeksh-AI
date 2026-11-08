/**
 * controllers/memory.controller.ts
 * -------------------------------
 * Memory APIs (Milestone 4 — additive; no M1/M2/M3 modifications).
 *
 * SECURITY:
 * - Identity comes from `getAuth(req)` (verified bearer token), never from
 *   the request body; any `user_id` a client sends is stripped by Zod.
 * - The user-scoped Supabase client (`getDb(req)`) carries the verified
 *   identity into RLS, so cross-user reads/writes are rejected by the DB.
 * - `credential`-class content is rejected before it reaches storage.
 */

import type { Request, Response, NextFunction } from 'express';
import { getAuth, getDb } from '../middleware/auth.middleware.js';
import * as MemoryService from '../services/memory.service.js';
import { looksLikeCredential } from '../services/credential.guard.js';
import {
  memoryInputSchema,
  memorySearchSchema,
  memoryUpdateSchema,
  memorySettingsSchema,
} from '../../../shared/schemas.js';

/** List the authenticated user's memories (newest first, bounded).
 *
 * Defaults to ACTIVE + NEEDS_REVIEW so conflict rows are discoverable and
 * can be reviewed/resolved. `?status=active|needs_review|all` narrows the
 * result; unknown values fall back to the default set (never a cross-user
 * query — ownership is always applied).
 */
export async function listMemories(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : '';
    const rawCategory = typeof req.query.category === 'string' ? req.query.category : '';
    const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    let builder = db.from('memories').select('*').eq('user_id', userId);
    if (rawStatus === 'active' || rawStatus === 'needs_review') {
      builder = builder.eq('status', rawStatus);
    } else {
      builder = builder.in('status', ['active', 'needs_review']);
    }
    if (rawCategory) builder = builder.eq('category', rawCategory);
    if (rawQuery) builder = builder.ilike('content', `%${rawQuery}%`);
    const { data, error } = await builder
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw new MemoryService.MemoryServiceError(error.message, error.code);
    res.json({ memories: data ?? [] });
  } catch (err) {
    next(err);
  }
}

/** Create a memory (explicit user action; provenance preserved). */
export async function createMemoryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const parsed = memoryInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }

    const result = await MemoryService.createMemory(db, userId, {
      content: parsed.data.content,
      category: parsed.data.category,
      sourceMessageId: parsed.data.source_message_id ?? null,
      evidence: parsed.data.source_evidence,
      confidence: parsed.data.confidence,
      sensitivity: parsed.data.sensitivity,
    });
    res.status(result.created ? 201 : 200).json({
      memory: result.memory,
      created: result.created,
      duplicate: !result.created,
    });
  } catch (err) {
    if (err instanceof MemoryService.MemoryServiceError && err.code === 'CREDENTIAL_BLOCKED') {
      res.status(403).json({ error: err.message });
      return;
    }
    next(err);
  }
}

/** Vector search through the `match_memories` SQL function (RPC). */
export async function searchMemoriesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const parsed = memorySearchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }

    const result = await MemoryService.retrieveMemories(db, userId, parsed.data.query_embedding ?? [], {
      threshold: parsed.data.threshold ?? 0.65,
      maxResults: parsed.data.max_results ?? 8,
      category: parsed.data.category,
      queryText: parsed.data.query_text,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/** Fetch one memory owned by the authenticated user. */
export async function getMemoryByIdHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);
    const memory = await MemoryService.getMemoryById(db, userId, req.params.id ?? '');
    if (!memory) {
      res.status(404).json({ error: 'Memory not found.' });
      return;
    }
    res.json({ memory });
  } catch (err) {
    next(err);
  }
}

/** Explicit user correction / status change on a memory. */
export async function updateMemoryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const parsed = memoryUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: 'No valid fields to update.' });
      return;
    }

    // Credential rejection on EDIT too (defense in depth): a user (or a
    // compromised session) can never write a secret into an existing row.
    if (parsed.data.content !== undefined && looksLikeCredential(parsed.data.content)) {
      res.status(403).json({ error: 'Credential information cannot be stored in a memory.' });
      return;
    }

    const { data, error } = await db
      .from('memories')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .select()
      .maybeSingle();

    if (error) throw new MemoryService.MemoryServiceError(error.message, error.code);
    if (!data) {
      res.status(404).json({ error: 'Memory not found.' });
      return;
    }
    res.json({ memory: data });
  } catch (err) {
    next(err);
  }
}

/** Delete a memory owned by the authenticated user. */
export async function deleteMemoryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);
    const { error } = await db.from('memories').delete().eq('id', req.params.id).eq('user_id', userId);
    if (error) throw new MemoryService.MemoryServiceError(error.message, error.code);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
}

/** User-confirmed supersession (never automatic — instruction 7). */
export async function supersedeMemoryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);
    const newMemoryId = (req.body as { new_memory_id?: unknown } | undefined)?.new_memory_id;
    if (typeof newMemoryId !== 'string' || !newMemoryId) {
      res.status(400).json({ error: 'new_memory_id required.' });
      return;
    }
    const updated = await MemoryService.supersedeMemory(db, userId, req.params.id ?? '', newMemoryId);
    res.json({ superseded: true, old_memory: req.params.id ?? '', superseded_by: newMemoryId, updated });
  } catch (err) {
    if (err instanceof MemoryService.MemoryServiceError) {
      const status = err.code === MemoryService.MEMORY_NOT_FOUND ? 404 : 400;
      res.status(status).json({ error: err.message });
      return;
    }
    next(err);
  }
}

/** Read (and lazily create) the user's memory settings. */
export async function getMemorySettingsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);
    const settings = await MemoryService.getMemorySettings(db, userId);
    res.json({ settings });
  } catch (err) {
    next(err);
  }
}

/** Update memory settings (user-controlled consent). */
export async function updateMemorySettingsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const parsed = memorySettingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }

    const settings = await MemoryService.updateMemorySettings(db, userId, parsed.data);
    res.json({ settings });
  } catch (err) {
    next(err);
  }
}
