/**
 * services/ai.service.ts
 * ----------------------
 * OpenAI integration with function calling (tool use).
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
 * - Upstream OpenAI failures become a sanitized `AiServiceError` (502/504)
 *   — raw SDK errors are logged, never returned to clients.
 */

import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildSystemPrompt } from '../prompts/system.prompt.js';
import { createTaskToolArgsSchema } from '../../../shared/schemas.js';
import * as taskService from './task.service.js';
import type { ChatResponse, MessageRole } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

if (!OPENAI_API_KEY) {
  throw new Error('Missing required environment variable: OPENAI_API_KEY');
}

/**
 * Explicit client options so a hung upstream cannot hang the request
 * indefinitely: 30s timeout, one retry for transient failures.
 */
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  timeout: 30_000,
  maxRetries: 1,
});

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
 * safe to send to clients (it never contains raw OpenAI error bodies).
 */
export class AiServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 502,
    public readonly expose = true,
  ) {
    super(message);
    this.name = 'AiServiceError';
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * The single tool exposed to the model. Note there is deliberately no
 * `user_id` property in the schema: the model has no way to express
 * "create this task for someone else".
 */
const createTaskTool: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'create_task',
    description:
      "Create a new task in the user's task list. Use this whenever the user asks to create, add, or remember a task or reminder.",
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
      },
      required: ['title'],
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

  // 3. Canonicalize the due date (validated by the schema).
  let dueDate: string | null = null;
  if (parsed.data.due_date) {
    dueDate = new Date(parsed.data.due_date).toISOString();
  }

  try {
    // 4. Idempotency: repeated identical tool calls in a conversation
    //    should not silently create duplicate open tasks.
    const duplicate = await taskService.findDuplicateTask(client, userId, title, dueDate);
    if (duplicate) {
      return JSON.stringify({
        success: true,
        deduplicated: true,
        task: {
          id: duplicate.id,
          title: duplicate.title,
          priority: duplicate.priority,
          status: duplicate.status,
          due_date: duplicate.due_date,
        },
      });
    }

    // 5. Create — ownership comes from the verified `userId`, full stop.
    const task = await taskService.createTask(client, userId, {
      title,
      priority,
      due_date: dueDate,
    });

    return JSON.stringify({
      success: true,
      task: {
        id: task.id,
        title: task.title,
        priority: task.priority,
        status: task.status,
        due_date: task.due_date,
      },
    });
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

/** Execute one tool call by name; unknown tools return an honest failure. */
async function dispatchToolCall(
  client: SupabaseClient,
  userId: string,
  name: string | undefined,
  rawArgs: string,
): Promise<string> {
  if (name === 'create_task') {
    return executeCreateTask(client, userId, rawArgs);
  }
  return JSON.stringify({ success: false, error: `Unknown tool: ${name ?? '(missing)'}` });
}

// ---------------------------------------------------------------------------
// OpenAI call wrapper — converts SDK failures into safe AiServiceErrors
// ---------------------------------------------------------------------------

type CompletionParams = Parameters<typeof openai.chat.completions.create>[0];

/**
 * Invoke the OpenAI chat completions API (non-streaming).
 * The SDK's overloaded return type includes `Stream`, so we assert the
 * concrete `ChatCompletion` shape — we never pass `stream: true`.
 */
async function createCompletion(
  params: CompletionParams,
): Promise<OpenAI.Chat.ChatCompletion> {
  try {
    const result = await openai.chat.completions.create(params);
    return result as OpenAI.Chat.ChatCompletion;
  } catch (err) {
    // Log full details server-side only.
    console.error('[ai.service] OpenAI request failed:', err instanceof Error ? err.message : err);

    // Timeouts / connection failures from the SDK are `APIConnectionTimeoutError`
    // or `APIConnectionError`; API errors carry a `status`.
    const status = (err as { status?: number } | null)?.status;
    if (err instanceof OpenAI.APIConnectionTimeoutError) {
      throw new AiServiceError('The AI service timed out. Please try again.', 504);
    }
    if (status && status >= 500) {
      throw new AiServiceError('The AI service is temporarily unavailable. Please try again.', 502);
    }
    if (status === 429) {
      throw new AiServiceError('The AI service is rate-limited. Please try again shortly.', 429);
    }
    throw new AiServiceError('The AI service is currently unavailable.', 502);
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
 */
export async function saveMessage(
  client: SupabaseClient,
  userId: string,
  role: MessageRole,
  content: string,
): Promise<void> {
  const { error } = await client.from('messages').insert({ user_id: userId, role, content });
  if (error) {
    console.error('[ai.service] Failed to persist message:', error.message);
  }
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
 */
export async function chat(
  client: SupabaseClient,
  userId: string,
  message: string,
): Promise<ChatResponse> {
  // 1. Server-authoritative history (never client-supplied).
  const history = await loadRecentHistory(client, userId);

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(userId) },
    ...history.map(
      (turn): ChatCompletionMessageParam =>
        ({ role: turn.role, content: turn.content }) as ChatCompletionMessageParam,
    ),
    { role: 'user', content: message },
  ];

  // 2. Bounded model↔tool loop.
  let finalContent: string | null = null;
  let finalModel = OPENAI_MODEL;
  let finalUsage: ChatResponse['usage'];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const completion = await createCompletion({
      model: OPENAI_MODEL,
      messages,
      tools: [createTaskTool],
      tool_choice: 'auto',
      temperature: 0.3,
    });

    const assistantMessage = completion.choices[0]?.message;

    // No tool calls → this is the final answer.
    if (!assistantMessage?.tool_calls?.length) {
      finalContent = assistantMessage?.content?.trim() ?? null;
      finalModel = completion.model;
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
    const completion = await createCompletion({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.3,
    });
    const assistantMessage = completion.choices[0]?.message;
    finalContent = assistantMessage?.content?.trim() ?? null;
    finalModel = completion.model;
    finalUsage = completion.usage
      ? {
          prompt_tokens: completion.usage.prompt_tokens,
          completion_tokens: completion.usage.completion_tokens,
          total_tokens: completion.usage.total_tokens,
        }
      : undefined;
  }

  return {
    reply: finalContent ?? "I'm sorry, I couldn't generate a response.",
    model: finalModel,
    usage: finalUsage,
  };
}
