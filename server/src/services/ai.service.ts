/**
 * services/ai.service.ts
 * ----------------------
 * Google Gemini integration via its OpenAI-compatible endpoint
 * (`https://generativelanguage.googleapis.com/v1beta/openai/`), using the
 * existing `openai` npm SDK. Tool calling (function calling) keeps the
 * standard OpenAI wire format: `tools`, `tool_choice`, assistant
 * `tool_calls`, and `role: 'tool'` result messages — all supported by the
 * Gemini compatibility layer, so no request-shape changes were required.
 * Gemini-only OpenAI fields (`parallel_tool_calls`, `response_format`,
 * `logprobs`, …) are deliberately never sent.
 *
 * Flow:
 *   1. Build the message array (system prompt + server-loaded history +
 *      latest user message).
 *   2. Call `chat.completions.create` with the `create_task` tool.
 *   3. If the model returns `tool_calls`, validate every argument with Zod,
 *      execute the tool against Supabase using the *authenticated* user's
 *      identity, feed the result back, and repeat — bounded to
 *      MAX_TOOL_ROUNDS iterations so a misbehaving model cannot loop.
 *   4. Return the final natural-language reply.
 *
 * SECURITY INVARIANTS:
 * - The model can never choose which user's data it touches: `userId` is a
 *   function parameter supplied by the auth middleware (via the controller),
 *   and any `user_id` the model puts in tool arguments is stripped by the
 *   Zod schema before execution.
 * - Tool results are honest: a database failure is reported to the model as
 *   `success: false` and is never summarized as a completed task.
 * - Upstream Gemini failures become a sanitized `AiServiceError` (429/502/504)
 *   — raw SDK errors are logged (with API keys redacted), never returned to
 *   clients.
 */

import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildSystemPrompt } from '../prompts/system.prompt.js';
import { createTaskToolArgsSchema, saveMemoryToolArgsSchema, MEMORY_CATEGORIES } from '../../../shared/schemas.js';
import * as taskService from './task.service.js';
import * as reminderService from './reminder.service.js';
import * as dateService from './date.service.js';
import * as memoryService from './memory.service.js';
import { embed } from './embedding.service.js';
import * as documentRetrieval from './documents/retrieval.service.js';
import { getDocumentsConfig } from '../config/documents.config.js';
import { validateCitations, buildSourceMap } from './documents/citation.service.js';
import type { ChatResponse, DocumentSource, MessageRole } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Gemini's OpenAI-compatible base URL. The `openai` SDK appends
 * `chat/completions` to this prefix, producing
 * `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`.
 * The SDK authenticates with `Authorization: Bearer <GEMINI_API_KEY>`, which
 * the Gemini compatibility endpoint accepts.
 */
export const GEMINI_OPENAI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/';

/** Default Gemini model when `GEMINI_MODEL` is not configured. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/** Ollama OpenAI-compatible base URL (local). */
export const OLLAMA_OPENAI_BASE_URL =
  'http://localhost:11434/v1/';

/** Default Ollama chat model for fallback. */
export const DEFAULT_OLLAMA_MODEL = 'mistral:latest';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
/** Optional override (e.g. regional endpoints or a local mock server). */
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL ?? GEMINI_OPENAI_BASE_URL;

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? OLLAMA_OPENAI_BASE_URL;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;

if (!GEMINI_API_KEY) {
  throw new Error('Missing required environment variable: GEMINI_API_KEY');
}

/**
 * Explicit client options so a hung upstream cannot hang the request
 * indefinitely: 30s timeout, one retry for transient failures.
 */
const gemini = new OpenAI({
  apiKey: GEMINI_API_KEY,
  baseURL: GEMINI_BASE_URL,
  timeout: 30_000,
  maxRetries: 1,
});

/**
 * Ollama client for fallback. No API key needed for local Ollama.
 * Longer timeout for cold model loads.
 *
 * Constructed LAZILY on the first eligible fallback: deployments that never
 * fall back should not pay for an unused client (and tests that inspect the
 * constructor order still see Gemini first).
 */
let ollamaClient: OpenAI | null = null;
function getOllamaClient(): OpenAI {
  if (!ollamaClient) {
    ollamaClient = new OpenAI({
      apiKey: 'ollama', // dummy key; Ollama ignores it
      baseURL: OLLAMA_BASE_URL,
      timeout: 120_000,
      maxRetries: 0,
    });
  }
  return ollamaClient;
}

/**
 * Which provider was used for the last successful request.
 * Used for observability/debugging.
 */
export let lastUsedProvider: 'gemini' | 'ollama' | null = null;

/**
 * Upper bound on model↔tool round trips per chat request.
 * Without a bound, a model stuck in a tool-call loop could hammer the
 * database indefinitely (cost + DoS vector).
 */
export const MAX_TOOL_ROUNDS = 3;

/** Upper bound on tool calls executed within a single round. */
export const MAX_TOOL_CALLS_PER_ROUND = 5;

// ---------------------------------------------------------------------------
// Error type for upstream AI failures
// ---------------------------------------------------------------------------

/**
 * AI-side failure with a client-safe message.
 * `expose: true` tells the app error handler that `message` is already
 * safe to send to clients (it never contains raw Gemini error bodies or
 * credentials).
 */
export class AiServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 502,
    public readonly expose = true,
    /** Whether this error is eligible for fallback to another provider. */
    public readonly fallbackEligible: boolean = false,
  ) {
    super(message);
    this.name = 'AiServiceError';
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * Tool #1 exposed to the model. Note there is deliberately no
 * `user_id` property in the schema: the model has no way to express
 * "create this task for someone else".
 */
const createTaskTool: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'create_task',
    description:
      "Create a new task in the user's task list. Use this whenever the user asks to create, add, or remember a task. Set reminder_at ONLY when the user explicitly asks to be reminded or notified — a due date is not a reminder.",
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'A short, clear title for the task (e.g. "Buy groceries").',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Priority level. Defaults to "medium" if not specified.',
        },
        due_date: {
          type: 'string',
          description:
            'Optional ISO-8601 due date (e.g. "2026-10-23T09:00:00Z"). Omit if the user did not mention a deadline.',
        },
        reminder_at: {
          type: 'string',
          description:
            'Optional reminder delivery time. Set ONLY when the user explicitly asks to be reminded/notified. Pass the user\'s exact phrase (e.g. "tomorrow at 9 AM", "in 2 hours", "day after tomorrow") or an ISO-8601 timestamp with offset (e.g. "2026-10-24T18:00:00+05:30"). The SERVER resolves phrases authoritatively in Asia/Kolkata (date-only defaults to 09:00). Omit when no reminder was requested — never invent one, and never reuse due_date as a reminder.',
        },
        recurrence: {
          type: 'string',
          enum: ['none', 'weekly'],
          description:
            'Set to "weekly" ONLY when the user explicitly asks for a repeating reminder (e.g. "every Monday at 8 AM"). Recurring reminders are NOT yet supported: the server schedules the NEXT occurrence only and will tell the user it is one-time. Do not set recurrence for one-time reminders.',
        },
      },
      required: ['title'],
    },
  },
};

/**
 * Tool #2 (Milestone 4.1 — Task C): explicit memory save. ONLY used when
 * the user directly asks the assistant to remember something ("remember
 * that…", "from now on…") — routine chat is NEVER auto-saved through this
 * tool (background extraction is a separate, consent-gated pipeline).
 *
 * There is deliberately no `user_id` property: ownership always comes from
 * the verified bearer token. Credentials are rejected server-side by the
 * `createMemory` auto-guard before anything is persisted.
 */
const saveMemoryTool: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'save_memory',
    description:
      "Save a durable fact about the user to their long-term memory. Call this ONLY when the user EXPLICITLY asks you to remember something (e.g. 'remember that I prefer Python', 'from now on call me Sam'). Do NOT use it for tasks or reminders (use create_task), and NEVER save passwords, API keys, tokens or other credentials.",
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            'A concise standalone statement of the fact, third person (e.g. "User prefers Python for programming.").',
        },
        category: {
          type: 'string',
          enum: [...MEMORY_CATEGORIES],
          description: 'Memory category. Defaults to "other" if unsure.',
        },
        evidence: {
          type: 'string',
          description:
            "Optional VERBATIM span copied exactly from the user's message that justifies this memory. Omit when no exact span applies.",
        },
      },
      required: ['content'],
    },
  },
};

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

/**
 * Execute a single `create_task` tool call.
 *
 * @param client User-scoped Supabase client (verified user's JWT).
 * @param userId Verified authenticated user id — the ONLY source of ownership.
 * @param rawArgs Raw JSON string produced by the model.
 * @returns JSON string fed back to the model as the tool message. Always
 *          reflects the true outcome of the database operation.
 */
async function executeCreateTask(
  client: SupabaseClient,
  userId: string,
  rawArgs: string,
): Promise<string> {
  // 1. Parse JSON safely.
  let json: unknown;
  try {
    json = JSON.parse(rawArgs);
  } catch {
    return JSON.stringify({
      success: false,
      error: 'Invalid JSON arguments provided to create_task.',
    });
  }

  // 2. Validate with Zod. Unknown keys (including any `user_id` the model
  //    might inject) are stripped, so they can never reach the service.
  const parsed = createTaskToolArgsSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return JSON.stringify({ success: false, error: `Invalid arguments: ${issues}` });
  }

  const { title, priority } = parsed.data;

  // 3. Resolve the due date deterministically (backend source of truth).
  // Relative-day phrases ("tomorrow", "day after tomorrow", "next Monday",
  // "next week") are resolved from the configured clock — never from the
  // model's internal calendar. This prevents stale-year hallucinations
  // (e.g. May 2025 when the real date is October/November 2026).
  let dueDate: string | null = null;
  if (parsed.data.due_date) {
    const input = parsed.data.due_date.trim();
    const lower = input.toLowerCase();

    let resolved: Date | null = null;

    if (lower === 'today') {
      resolved = new Date();
    } else if (lower === 'tomorrow') {
      resolved = dateService.tomorrow();
    } else if (lower === 'day after tomorrow') {
      resolved = dateService.dayAfterTomorrow();
    } else if (lower === 'next monday') {
      resolved = dateService.nextMonday();
    } else if (lower === 'next week') {
      resolved = dateService.nextWeek();
    } else {
      // Explicit date/time string — parse and validate.
      resolved = new Date(input);
    }

    if (resolved && !isNaN(resolved.getTime())) {
      // Reject stale-year dates (e.g. May 2025 from training cutoff).
      if (dateService.isStaleDate(resolved.toISOString())) {
        return JSON.stringify({
          success: false,
          error:
            'The date appears invalid or stale. Please provide an explicit future date.',
        });
      }
      dueDate = resolved.toISOString();
    } else {
      return JSON.stringify({
        success: false,
        error: 'Invalid due_date format. Use an ISO-8601 date/time (e.g. "2026-10-24T09:00:00+05:30").',
      });
    }
  }

  // 3b. Resolve the OPTIONAL reminder time BEFORE any database write.
  //     A due date is NOT a reminder: reminder_at is only present when the
  //     user explicitly asked to be reminded. Invalid or past reminder
  //     times fail here with ZERO side effects (no orphan task rows).
  let reminderAtIso: string | null = null;
  let recurrenceNote: string | null = null;

  if (parsed.data.reminder_at) {
    const resolvedReminder = dateService.resolveFutureReminderTime(
      parsed.data.reminder_at,
    );
    if (!resolvedReminder.ok) {
      return JSON.stringify({ success: false, error: resolvedReminder.message });
    }
    reminderAtIso = resolvedReminder.iso;

    if (parsed.data.recurrence === 'weekly') {
      // EXPLICIT handling (never silent): schedule the next occurrence
      // only and make sure the user is told recurrence is unsupported.
      recurrenceNote =
        'Recurring reminders are not supported yet: only the NEXT occurrence was scheduled. Tell the user this reminder is currently one-time.';
    }
  } else if (parsed.data.recurrence === 'weekly') {
    return JSON.stringify({
      success: false,
      error:
        'A recurring reminder was requested without a reminder time. Ask the user when the reminder should fire (e.g. "every Monday at 8 AM").',
    });
  }

  /**
   * Create the reminder for a task and return an honest outcome object.
   * Never throws — a reminder failure must not destroy the already
   * created task, but it must be reported truthfully to the model.
   */
  async function createReminderForTask(
    taskId: string,
  ): Promise<
    | { ok: true; reminder: { id: string; reminder_at: string; status: string }; created: boolean }
    | { ok: false; error: string }
  > {
    if (!reminderAtIso) return { ok: false, error: 'no reminder requested' };
    try {
      const { reminder, created } = await reminderService.createReminder(
        client,
        userId,
        {
          title,
          task_id: taskId,
          reminder_at: reminderAtIso,
          // Idempotency: identical tool retries must not stack reminders.
          idempotency_key: `ai:${taskId}:${reminderAtIso}`,
        },
      );
      return {
        ok: true,
        reminder: { id: reminder.id, reminder_at: reminder.reminder_at, status: reminder.status },
        created,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error('[ai.service] create reminder failed:', message);
      return {
        ok: false,
        error:
          'The task was saved, but the reminder could NOT be saved. Tell the user honestly that no reminder was set and ask them to try again.',
      };
    }
  }

  try {
    // 4. Idempotency: repeated identical tool calls in a conversation
    //    should not silently create duplicate open tasks.
    const duplicate = await taskService.findDuplicateTask(client, userId, title, dueDate);
    if (duplicate) {
      const result: Record<string, unknown> = {
        success: true,
        deduplicated: true,
        task: {
          id: duplicate.id,
          title: duplicate.title,
          priority: duplicate.priority,
          status: duplicate.status,
          due_date: duplicate.due_date,
        },
      };
      if (reminderAtIso) {
        // Still ensure the reminder exists for the deduplicated task
        // (idempotency key makes this a no-op when it already does).
        const reminderOutcome = await createReminderForTask(duplicate.id);
        if (reminderOutcome.ok) {
          result.reminder = reminderOutcome.reminder;
        } else {
          result.warning = reminderOutcome.error;
        }
      }
      if (recurrenceNote) result.note = recurrenceNote;
      return JSON.stringify(result);
    }

    // 5. Create — ownership comes from the verified `userId`, full stop.
    const task = await taskService.createTask(client, userId, {
      title,
      priority,
      due_date: dueDate,
    });

    // 6. Optional reminder — task and reminder are persisted in this order;
    //    a reminder failure is reported as an explicit warning rather than
    //    a fake success (and never rolls back / deletes the user's task).
    const payload: Record<string, unknown> = {
      success: true,
      task: {
        id: task.id,
        title: task.title,
        priority: task.priority,
        status: task.status,
        due_date: task.due_date,
      },
    };

    if (reminderAtIso) {
      const reminderOutcome = await createReminderForTask(task.id);
      if (reminderOutcome.ok) {
        payload.reminder = reminderOutcome.reminder;
      } else {
        payload.warning = reminderOutcome.error;
      }
    }
    if (recurrenceNote) payload.note = recurrenceNote;

    return JSON.stringify(payload);
  } catch (err) {
    // Honest failure: the model must NOT claim the task was created.
    // Log the real cause server-side; return a generic reason to the model.
    console.error('[ai.service] create_task failed:', err instanceof Error ? err.message : err);
    return JSON.stringify({
      success: false,
      error: 'The task could not be saved to the database.',
    });
  }
}

/**
 * Execute a single `save_memory` tool call (Milestone 4.1 — Task C).
 *
 * Explicit user request only (the system prompt restricts when the model
 * may call this). Runs through `memoryService.createMemory`, which:
 * - embeds in the ACTIVE provider space and stores provider/model metadata,
 * - REJECTS credential-shaped content (CREDENTIAL_BLOCKED — reported back
 *   to the model as a hard "never store this" result, never persisted),
 * - records provenance: `source_message_id` is the user message that
 *   triggered the call (when supplied by the controller).
 *
 * Failures are reported honestly to the model — it must never claim a
 * memory was saved when the database rejected it. Nothing here can throw
 * into the chat response.
 *
 * @returns JSON string fed back to the model as the tool message.
 */
async function executeSaveMemory(
  client: SupabaseClient,
  userId: string,
  rawArgs: string,
  sourceMessageId: string | null,
): Promise<string> {
  let json: unknown;
  try {
    json = JSON.parse(rawArgs);
  } catch {
    return JSON.stringify({
      success: false,
      error: 'Invalid JSON arguments provided to save_memory.',
    });
  }

  // Zod strips unknown keys (including any `user_id` the model invented).
  const parsed = saveMemoryToolArgsSchema.safeParse(json);
  if (!parsed.success) {
    return JSON.stringify({
      success: false,
      error: 'Invalid save_memory arguments.',
      details: parsed.error.flatten(),
    });
  }

  try {
    const result = await memoryService.createMemory(client, userId, {
      content: parsed.data.content,
      category: parsed.data.category,
      evidence: parsed.data.evidence,
      confidence: 'high', // the USER explicitly asked for this to be remembered
      sourceMessageId,
    });
    return JSON.stringify({
      success: true,
      created: result.created,
      memory: {
        id: result.memory.id,
        content: result.memory.content,
        category: result.memory.category,
        status: result.memory.status,
      },
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'CREDENTIAL_BLOCKED') {
      // Tell the model (and through it the user) this can never be stored.
      return JSON.stringify({
        success: false,
        error:
          'Refused: passwords, API keys, tokens and other credentials are never stored as memories. Do not attempt to save them.',
      });
    }
    console.error('[ai.service] save_memory failed:', err instanceof Error ? err.message : err);
    return JSON.stringify({
      success: false,
      error: 'The memory could not be saved to the database.',
    });
  }
}

/** Execute one tool call by name; unknown tools return an honest failure. */
async function dispatchToolCall(
  client: SupabaseClient,
  userId: string,
  name: string | undefined,
  rawArgs: string,
  opts?: { sourceMessageId?: string | null },
): Promise<string> {
  if (name === 'create_task') {
    return executeCreateTask(client, userId, rawArgs);
  }
  if (name === 'save_memory') {
    return executeSaveMemory(client, userId, rawArgs, opts?.sourceMessageId ?? null);
  }
  return JSON.stringify({ success: false, error: `Unknown tool: ${name ?? '(missing)'}` });
}

// ---------------------------------------------------------------------------
// Gemini call wrapper — converts SDK failures into safe AiServiceErrors
// ---------------------------------------------------------------------------

type CompletionParams = Parameters<typeof gemini.chat.completions.create>[0];

/**
 * Redact API-key-shaped substrings (Google `AIza…` keys and `sk-…` style
 * keys) before anything is written to logs. Upstream error text sometimes
 * echoes the rejected credential; we never want it persisted.
 */
function sanitizeForLog(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.replace(/(AIza[0-9A-Za-z_-]{8,}|sk-[A-Za-z0-9_-]{8,})/g, '[redacted]');
}

/**
 * Map a Gemini (OpenAI-compatible) failure to a client-safe `AiServiceError`.
 *
 * Distinguishes: invalid credentials, unavailable model, exhausted quota,
 * transient rate limiting, upstream outages, and timeouts. Client messages
 * are accurate but contain no upstream details or secrets.
 */
function mapUpstreamError(err: unknown): AiServiceError {
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new AiServiceError('The AI service timed out. Please try again.', 504, true, true);
  }

  const status = (err as { status?: number } | null)?.status;
  const code = String((err as { code?: string | number } | null)?.code ?? '').toLowerCase();
  const message = err instanceof Error ? err.message : String(err);
  const detail = `${code} ${message}`.toLowerCase();

  // Invalid or revoked credentials (server-side misconfiguration).
  if (
    status === 401 ||
    status === 403 ||
    detail.includes('api_key_invalid') ||
    detail.includes('api key not valid') ||
    detail.includes('permission_denied') ||
    detail.includes('unauthenticated')
  ) {
    return new AiServiceError(
      'The AI service rejected the server credentials. Please contact the site operator.',
      502,
      true,
      false, // NOT fallback eligible - auth won't work on another provider
    );
  }

  // Configured model missing/retired (typo in GEMINI_MODEL, etc.).
  if (
    status === 404 ||
    detail.includes('model_not_found') ||
    (detail.includes('not found') && detail.includes('model')) ||
    detail.includes('unsupported model') ||
    detail.includes('is not found for api version')
  ) {
    return new AiServiceError(
      'The configured AI model is unavailable. Please contact the site operator.',
      502,
      true,
      false, // NOT fallback eligible - model config issue
    );
  }

  // Quota exhaustion vs transient rate limiting — both surface as 429.
  if (status === 429 || detail.includes('resource_exhausted')) {
    if (detail.includes('quota') || detail.includes('billing')) {
      return new AiServiceError(
        'The AI service quota has been exhausted. Please try again later or contact the site operator.',
        429,
        true,
        true, // fallback eligible - quota on Gemini doesn't mean Ollama has quota issues
      );
    }
    return new AiServiceError(
      'The AI service is rate-limited or out of quota. Please try again later.',
      429,
      true,
      true, // fallback eligible
    );
  }

  if (status && status >= 500) {
    return new AiServiceError(
      'The AI service is temporarily unavailable. Please try again.',
      502,
      true,
      true, // fallback eligible
    );
  }

  return new AiServiceError('The AI service is currently unavailable.', 502, true, false);
}

// ---------------------------------------------------------------------------
// Error helper to match error objects in tests
// ---------------------------------------------------------------------------
export function matchAiError(
  message: string,
  statusCode: number,
  expose: boolean = true,
) {
  return {
    name: 'AiServiceError',
    message,
    statusCode,
    expose,
  };
}

/**
 * Invoke the chat completions API through the OpenAI SDK for a given provider.
 * (non-streaming). The SDK's overloaded return type includes `Stream`, so we
 * assert the concrete `ChatCompletion` shape — we never pass `stream: true`.
 */
async function createCompletionWithProvider(
  provider: 'gemini' | 'ollama',
  params: CompletionParams,
): Promise<OpenAI.Chat.ChatCompletion> {
  const client = provider === 'gemini' ? gemini : getOllamaClient();
  const model = provider === 'gemini' ? GEMINI_MODEL : OLLAMA_MODEL;
  
  try {
    const result = await client.chat.completions.create({
      ...params,
      model,
    });
    lastUsedProvider = provider;
    return result as OpenAI.Chat.ChatCompletion;
  } catch (err) {
    // Log full details server-side only, with any API keys redacted.
    console.error(`[ai.service] ${provider} request failed:`, sanitizeForLog(err));
    
    if (provider === 'gemini') {
      throw mapUpstreamError(err);
    } else {
      // For Ollama, create a generic error
      const msg = err instanceof Error ? err.message : String(err);
      throw new AiServiceError(`Ollama request failed: ${msg}`, 502);
    }
  }
}

/**
 * Invoke Gemini with fallback to Ollama on eligible failures.
 * Falls back only for: timeout, network, rate limit, quota, 5xx errors.
 * Does NOT fall back for: 400 (validation), 401/403 (auth), 404 (model not found).
 */
async function createCompletionWithFallback(
  params: CompletionParams,
): Promise<OpenAI.Chat.ChatCompletion> {
  // Try Gemini first
  try {
    return await createCompletionWithProvider('gemini', params);
  } catch (err) {
    if (err instanceof AiServiceError) {
      // Check if error is eligible for fallback
      if (err.fallbackEligible) {
        console.warn(`[ai.service] Gemini failed with ${err.statusCode}, falling back to Ollama`);
        try {
          return await createCompletionWithProvider('ollama', params);
        } catch (ollamaErr) {
          console.error('[ai.service] Ollama fallback also failed:', sanitizeForLog(ollamaErr));
          // Preserve the original, client-safe Gemini error. The fallback
          // failure is an operational detail (logged above), not something
          // that should change the user-facing contract or leak provider
          // internals into the API response.
          throw err;
        }
      }
    }
    // Not eligible for fallback, or not an AiServiceError - rethrow
    throw err;
  }
}

// ---------------------------------------------------------------------------
// History persistence (always user-scoped)
// ---------------------------------------------------------------------------

export interface ChatTurn {
  role: MessageRole;
  content: string;
}

/**
 * Load recent chat history for the verified user so the model has context.
 * Server-authoritative: clients cannot inject turns (the request schema no
 * longer accepts a `history` field, closing the context-spoofing vector).
 *
 * RLS + the `.eq('user_id')` filter mean one user's history can never be
 * read with another user's client.
 */
export async function loadRecentHistory(
  client: SupabaseClient,
  userId: string,
  limit = 10,
): Promise<ChatTurn[]> {
  const { data, error } = await client
    .from('messages')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) {
    // History is best-effort: log and continue with an empty transcript
    // rather than failing the chat request.
    console.error('[ai.service] Failed to load history:', error?.message ?? 'no data');
    return [];
  }

  // Reverse so the array is oldest → newest.
  return (data as ChatTurn[]).reverse();
}

/**
 * Persist a chat turn to the `messages` table (scoped to the verified user).
 * Failures are logged but not thrown: losing a history row must not lose
 * the reply the user is about to receive. The caller decides criticality.
 *
 * @returns the inserted message id (null when persistence failed or the
 *          client does not return rows), so the caller can link provenance.
 */
export async function saveMessage(
  client: SupabaseClient,
  userId: string,
  role: MessageRole,
  content: string,
): Promise<string | null> {
  const { data, error } = await client
    .from('messages')
    .insert({ user_id: userId, role, content })
    .select('id')
    .single();
  if (error) {
    console.error('[ai.service] Failed to persist message:', error.message);
    return null;
  }
  return String((data as { id?: string } | null)?.id ?? null);
}

// ---------------------------------------------------------------------------
// Main chat function
// ---------------------------------------------------------------------------

/**
 * Send a user message to the model, execute any tool calls (bounded), and
 * return the final assistant reply.
 *
 * @param client User-scoped Supabase client from the auth middleware.
 * @param userId Verified authenticated user id.
 * @param message Latest user utterance (already Zod-validated).
 * @param sourceMessageId id of the persisted user turn whose provenance
 *        tool calls (save_memory) should reference; null when unavailable.
 */
export async function chat(
  client: SupabaseClient,
  userId: string,
  message: string,
  sourceMessageId: string | null = null,
  options?: { documentIds?: string[]; useDocuments?: boolean },
): Promise<ChatResponse> {
  // 1. Server-authoritative history (never client-supplied).
  const history = await loadRecentHistory(client, userId);

  // Dynamic date/time context — computed from the configured timezone at
  // request time so relative-date requests do not fall back to the model's
  // stale training cutoff (the root cause of the May-2025 output).
  const timeString = dateService.getLocalNowString('Asia/Kolkata');

  // 1b. Long-term memory (Milestone 4). Best-effort and non-fatal: any
  //     failure yields null and chat proceeds unchanged. The payload is
  //     appended to the USER turn — never to the system prompt — so memory
  //     stays untrusted reference data, not an instruction. The system
  //     prompt already carries the isolation rules.
  let userContent = message;
  let documentSources: DocumentSource[] = [];
  let documentContextUsed = false;
  try {
    // role 'query' applies the official asymmetric retrieval format so the
    // query side matches how memories were embedded as documents (M4.1).
    const queryEmbedding = await embed(message, { mock: process.env.NODE_ENV === 'test', role: 'query' });

    // Memory context (existing, unchanged).
    const memoryContext = await memoryService.loadChatMemoryContext(client, userId, queryEmbedding, message);
    if (memoryContext) {
      userContent = `${message}\n\n${memoryContext}`;
    }

    // Document context (Milestone 5). Heuristic + explicit selection;
    // no extra LLM routing call.
    const config = getDocumentsConfig();
    const explicitIds = options?.documentIds?.filter(Boolean) ?? [];
    const forceDocs = options?.useDocuments === true;
    const hasDocCue = /document|pdf|file|uploaded|according to|summarize|what does .* say|compare/i.test(message);

    // Check if user has any ready documents (best-effort).
    let hasReadyDocs = false;
    try {
      const { data } = await client
        .from('documents')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'ready')
        .limit(1);
      hasReadyDocs = Array.isArray(data) && data.length > 0;
    } catch {
      hasReadyDocs = false;
    }

    const shouldRetrieve =
      hasReadyDocs && (explicitIds.length > 0 || forceDocs || hasDocCue);

    if (shouldRetrieve) {
      const hits = await documentRetrieval.searchDocumentChunks(client, userId, queryEmbedding, {
        documentIds: explicitIds.length > 0 ? explicitIds : undefined,
        threshold: config.retrievalThreshold,
        maxResults: config.chatTopK,
      });

      if (hits.length > 0) {
        documentContextUsed = true;
        // Build the labelled context block (appended to user turn).
        const contextLines: string[] = [];
        const markerMap = new Map<string, typeof hits[0]>();
        hits.forEach((hit, idx) => {
          const marker = `S${idx + 1}`;
          markerMap.set(marker, hit);
          const pagePart = hit.pageStart ? `page: ${hit.pageStart}` : 'page: n/a';
          const headingPart = hit.heading ? `section: ${hit.heading}` : '';
          contextLines.push(
            `[${marker}] file: ${hit.filename} | ${pagePart}${headingPart ? ' | ' + headingPart : ''}\n${hit.content}`,
          );
        });

        const contextBlock = `<document_context untrusted="true">\n${contextLines.join('\n\n')}\n</document_context>`;
        userContent = `${userContent}\n\n${contextBlock}`;

        // Build sources (only resolvable markers).
        documentSources = hits.map((hit, idx) => ({
          marker: `S${idx + 1}`,
          document_id: hit.documentId,
          chunk_id: hit.chunkId,
          filename: hit.filename,
          page: hit.pageStart,
          heading: hit.heading,
          similarity: hit.similarity,
        }));
      }
    }
  } catch (err) {
    console.warn('[ai.service] document context skipped (non-fatal):', err instanceof Error ? err.message : err);
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(userId, { now: timeString, timezone: 'Asia/Kolkata' }) },
    ...history.map(
      (turn): ChatCompletionMessageParam =>
        ({ role: turn.role, content: turn.content }) as ChatCompletionMessageParam,
    ),
    { role: 'user', content: userContent },
  ];

  // 2. Bounded model↔tool loop.
  let finalContent: string | null = null;
  let finalModel = GEMINI_MODEL;
  let finalUsage: ChatResponse['usage'];
  let toolRoundProvider: 'gemini' | 'ollama' = 'gemini';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const completion = await createCompletionWithFallback({
      model: finalModel, // Will be overridden by createCompletionWithFallback
      messages,
      // save_memory is appended as tool #1 so `create_task` keeps its
      // position as tools[0] (asserted by the existing tool suite).
      tools: [createTaskTool, saveMemoryTool],
      tool_choice: 'auto',
      temperature: 0.3,
    });

    const assistantMessage = completion.choices[0]?.message;

    // No tool calls → this is the final answer.
    if (!assistantMessage?.tool_calls?.length) {
      finalContent = assistantMessage?.content?.trim() ?? null;
      finalModel = completion.model;
      toolRoundProvider = lastUsedProvider ?? 'gemini';
      finalUsage = completion.usage
        ? {
            prompt_tokens: completion.usage.prompt_tokens,
            completion_tokens: completion.usage.completion_tokens,
            total_tokens: completion.usage.total_tokens,
          }
        : undefined;
      break;
    }

    // Execute tool calls (bounded per round) and append results.
    messages.push(assistantMessage as ChatCompletionMessageParam);

    const toolCalls = assistantMessage.tool_calls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
    for (const toolCall of toolCalls) {
      const toolResult = await dispatchToolCall(
        client,
        userId,
        toolCall.function?.name,
        toolCall.function?.arguments ?? '',
        { sourceMessageId },
      );
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult,
      } as ChatCompletionMessageParam);
    }
  }

  // 3. If we exhausted MAX_TOOL_ROUNDS while the model was still asking to
  //    call tools, ask one final time WITHOUT tools so the user always gets
  //    a text reply and the loop is strictly bounded.
  if (finalContent === null) {
    const completion = await createCompletionWithFallback({
      model: finalModel,
      messages,
      temperature: 0.3,
    });
    const assistantMessage = completion.choices[0]?.message;
    finalContent = assistantMessage?.content?.trim() ?? null;
    finalModel = completion.model;
    toolRoundProvider = lastUsedProvider ?? 'gemini';
    finalUsage = completion.usage
      ? {
          prompt_tokens: completion.usage.prompt_tokens,
          completion_tokens: completion.usage.completion_tokens,
          total_tokens: completion.usage.total_tokens,
        }
      : undefined;
  }

  // Validate citations: drop any markers the model invented.
  if (documentSources.length > 0 && finalContent) {
    const sourceMap = buildSourceMap(documentSources);
    const citationResult = validateCitations(finalContent, sourceMap);
    if (citationResult.invalidMarkers.length > 0) {
      console.warn('[ai.service] dropped invented citation markers:', citationResult.invalidMarkers);
    }
    // Only return sources that were actually cited (or all if none cited but context was used).
    if (citationResult.sources.length > 0) {
      documentSources = citationResult.sources;
    }
  }

  return {
    reply: finalContent ?? "I'm sorry, I couldn't generate a response.",
    model: `${toolRoundProvider}:${finalModel}`,
    usage: finalUsage,
    sources: documentSources.length > 0 ? documentSources : undefined,
    document_context_used: documentContextUsed,
  };
}
