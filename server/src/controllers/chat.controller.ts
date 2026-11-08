/**
 * controllers/chat.controller.ts
 * ------------------------------
 * Handles POST /api/chat — the conversational entry point that drives
 * the OpenAI tool-calling loop and persists chat history.
 *
 * SECURITY:
 * - The user id comes from `getAuth(req)` (verified bearer token), never
 *   from the request body (the body schema has no `user_id` field).
 * - Conversation history is loaded server-side by ai.service, scoped to the
 *   authenticated user; clients can no longer inject context turns.
 * - The same user-scoped Supabase client flows into the AI service, so any
 *   `create_task` tool call runs under the authenticated identity + RLS.
 */

import type { Request, Response, NextFunction } from 'express';
import { chatRequestSchema } from '../../../shared/schemas.js';
import * as aiService from '../services/ai.service.js';
import * as MemoryService from '../services/memory.service.js';
import { getAuth, getDb } from '../middleware/auth.middleware.js';
import type { ChatResponse } from '../../../shared/types.js';

export async function chatHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // 1. Verified identity + user-scoped DB client (from auth middleware).
    const { userId } = getAuth(req);
    const db = getDb(req);

    // 2. Validate the payload with Zod (strips unknown keys like user_id).
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid chat payload', details: parsed.error.flatten() });
      return;
    }

    // 3. Persist the user's message (best-effort; failures are logged).
    const messageId = await aiService.saveMessage(db, userId, 'user', parsed.data.message);

    // 4. Run the OpenAI chat + tool-calling loop. History is loaded inside
    //    the service, scoped to `userId`. Upstream failures surface as
    //    AiServiceError with a client-safe message.
    const response: ChatResponse = await aiService.chat(db, userId, parsed.data.message, messageId ?? null);

    // 5. Persist the assistant's reply (best-effort).
    const assistantId = await aiService.saveMessage(db, userId, 'assistant', response.reply);

    // 6. Consent-gated durable extraction (Milestone 4.1 — Task C):
    //    enqueues ONLY when automatic_memory_extraction is ON; never blocks
    //    the response, never runs when consent is off (default).
    if (messageId) {
      void MemoryService.enqueueMemoryExtraction(db, userId, messageId);
    }

    res.status(200).json(response);
  } catch (err) {
    next(err);
  }
}
