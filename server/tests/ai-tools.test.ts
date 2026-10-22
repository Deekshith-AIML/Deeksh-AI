/**
 * tests/ai-tools.test.ts
 * ----------------------
 * Service-level tests for the `create_task` tool pipeline in ai.service:
 * argument validation, honest success/failure reporting, idempotency,
 * bounded iteration, and safe upstream error mapping.
 *
 * OpenAI is mocked (`vi.mock('openai')`) — no API calls or charges.
 * Supabase is the in-memory fake.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const { openaiCreate } = vi.hoisted(() => ({ openaiCreate: vi.fn() }));

vi.mock('openai', () => {
  class APIConnectionTimeoutError extends Error {}
  class APIError extends Error {}
  class FakeOpenAI {
    chat = { completions: { create: openaiCreate } };
    static APIConnectionTimeoutError = APIConnectionTimeoutError;
    static APIError = APIError;
    constructor(_options?: unknown) {}
  }
  return { default: FakeOpenAI };
});

vi.mock('../src/services/supabase.service.js', async () => {
  const { fakeCreateUserScopedClient } = await import('./helpers/fakeSupabase.js');
  return {
    createUserScopedClient: fakeCreateUserScopedClient,
    createAdminClient: () => {
      throw new Error('admin client unavailable in tests');
    },
  };
});

import { chat, MAX_TOOL_ROUNDS } from '../src/services/ai.service.js';
import {
  fakeCreateUserScopedClient,
  registerUser,
  resetFakeSupabase,
  fakeDb,
  injectDatabaseFailure,
} from './helpers/fakeSupabase.js';
import {
  assistantReply,
  assistantWithToolCalls,
  createTaskCall,
} from './helpers/openaiMocks.js';

const TOKEN = 'headerT.payloadT.signatureT';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

type Msg = { role: string; content?: string | null };

/** Tool messages present in a captured completion request. */
function toolMessagesOf(callIndex: number): Msg[] {
  const call = openaiCreate.mock.calls[callIndex]?.[0] as { messages: Msg[] };
  return call.messages.filter((m) => m.role === 'tool');
}

describe('create_task tool execution', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser(TOKEN, USER, 'a@example.com');
    openaiCreate.mockReset();
  });

  it('rejects tool arguments that are not valid JSON', async () => {
    openaiCreate
      .mockResolvedValueOnce(
        assistantWithToolCalls([{ name: 'create_task', args: '{not json' }]),
      )
      .mockResolvedValueOnce(assistantReply('Sorry, that failed.'));

    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'create a task');

    const result = JSON.parse(String(toolMessagesOf(1)[0]?.content));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid json/i);
    expect(fakeDb.tasks).toHaveLength(0);
  });

  it('rejects tool arguments missing a title', async () => {
    openaiCreate
      .mockResolvedValueOnce(
        assistantWithToolCalls([createTaskCall({ priority: 'high' })]),
      )
      .mockResolvedValueOnce(assistantReply('missing title'));

    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'create a task');

    const result = JSON.parse(String(toolMessagesOf(1)[0]?.content));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid arguments/i);
    expect(fakeDb.tasks).toHaveLength(0);
  });

  it('rejects an unparseable due_date', async () => {
    openaiCreate
      .mockResolvedValueOnce(
        assistantWithToolCalls([createTaskCall({ title: 'x', due_date: 'next tuesday-ish' })]),
      )
      .mockResolvedValueOnce(assistantReply('bad date'));

    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'create a task');

    const result = JSON.parse(String(toolMessagesOf(1)[0]?.content));
    expect(result.success).toBe(false);
    expect(fakeDb.tasks).toHaveLength(0);
  });

  it('ignores a user_id injected into tool arguments by the model', async () => {
    openaiCreate
      .mockResolvedValueOnce(
        assistantWithToolCalls([
          createTaskCall({ title: 'Sneaky task', user_id: OTHER_USER }),
        ]),
      )
      .mockResolvedValueOnce(assistantReply('done'));

    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'create a task');

    expect(fakeDb.tasks).toHaveLength(1);
    expect(fakeDb.tasks[0]!.user_id).toBe(USER);
    expect(fakeDb.tasks[0]!.user_id).not.toBe(OTHER_USER);
  });

  it('reports success:false to the model when the database insert fails', async () => {
    injectDatabaseFailure('tasks', 'insert', 'simulated: disk full');
    openaiCreate
      .mockResolvedValueOnce(
        assistantWithToolCalls([createTaskCall({ title: 'Doomed task' })]),
      )
      .mockResolvedValueOnce(assistantReply('I could not save that task.'));

    const response = await chat(
      fakeCreateUserScopedClient(TOKEN),
      USER,
      'create a task',
    );

    // The tool result must honestly reflect the failure…
    const result = JSON.parse(String(toolMessagesOf(1)[0]?.content));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/could not be saved/i);

    // …and no task row must exist.
    expect(fakeDb.tasks).toHaveLength(0);

    // The user-visible reply is whatever the model produced (it is told
    // the tool failed; we only assert we did not fake a success payload).
    expect(response.reply.length).toBeGreaterThan(0);
  });

  it('returns success:true with the persisted task on a healthy insert', async () => {
    openaiCreate
      .mockResolvedValueOnce(
        assistantWithToolCalls([createTaskCall({ title: 'Good task', priority: 'low' })]),
      )
      .mockResolvedValueOnce(assistantReply('Saved!'));

    const response = await chat(fakeCreateUserScopedClient(TOKEN), USER, 'create a task');

    expect(response.reply).toBe('Saved!');
    expect(fakeDb.tasks).toHaveLength(1);
    expect(fakeDb.tasks[0]).toMatchObject({
      user_id: USER,
      title: 'Good task',
      priority: 'low',
      status: 'todo',
    });

    const result = JSON.parse(String(toolMessagesOf(1)[0]?.content));
    expect(result.success).toBe(true);
    expect(result.task.id).toBe(fakeDb.tasks[0]!.id);
  });

  it('answers unknown tool names with an honest failure', async () => {
    openaiCreate
      .mockResolvedValueOnce(
        assistantWithToolCalls([{ name: 'delete_all_users', args: '{}' }]),
      )
      .mockResolvedValueOnce(assistantReply('unknown tool'));

    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'do something');

    const result = JSON.parse(String(toolMessagesOf(1)[0]?.content));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown tool/i);
  });

  it('deduplicates repeated identical create_task calls (idempotency)', async () => {
    const args = { title: 'Buy groceries', due_date: '2026-11-01T09:00:00Z' };

    // First conversation: task is created.
    openaiCreate
      .mockResolvedValueOnce(assistantWithToolCalls([createTaskCall(args)]))
      .mockResolvedValueOnce(assistantReply('Created.'));
    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'create task');

    expect(fakeDb.tasks).toHaveLength(1);

    // Second conversation repeating the same request: no duplicate row.
    openaiCreate
      .mockResolvedValueOnce(assistantWithToolCalls([createTaskCall(args)]))
      .mockResolvedValueOnce(assistantReply('Already existed.'));
    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'create the same task again');

    expect(fakeDb.tasks).toHaveLength(1);

    // The model was told it was a duplicate, not that a new task was made.
    const secondTurnTool = toolMessagesOf(3)[0];
    const result = JSON.parse(String(secondTurnTool?.content));
    expect(result.success).toBe(true);
    expect(result.deduplicated).toBe(true);
    expect(result.task.id).toBe(fakeDb.tasks[0]!.id);
  });

  it('allows re-creating a task that was previously completed', async () => {
    openaiCreate
      .mockResolvedValueOnce(assistantWithToolCalls([createTaskCall({ title: 'Gym' })]))
      .mockResolvedValueOnce(assistantReply('created'));
    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'create gym task');

    // Complete it, then ask for it again — a new task is legitimate here.
    fakeDb.tasks[0]!.status = 'done';

    openaiCreate
      .mockResolvedValueOnce(assistantWithToolCalls([createTaskCall({ title: 'Gym' })]))
      .mockResolvedValueOnce(assistantReply('created again'));
    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'create gym task again');

    expect(fakeDb.tasks).toHaveLength(2);
  });
});

describe('tool loop bounds and upstream errors', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser(TOKEN, USER, 'a@example.com');
    openaiCreate.mockReset();
  });

  it('stops after MAX_TOOL_ROUNDS even if the model always requests tools', async () => {
    // Model never stops asking for tools.
    openaiCreate.mockImplementation(async () =>
      assistantWithToolCalls([createTaskCall({ title: 'Loop task' })]),
    );

    const response = await chat(fakeCreateUserScopedClient(TOKEN), USER, 'loop');

    // MAX_TOOL_ROUNDS rounds with tools + one final no-tools completion.
    expect(openaiCreate).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1);
    // Idempotency means the loop could not spray duplicate rows either.
    expect(fakeDb.tasks).toHaveLength(1);
    expect(response.reply).toBeTruthy();
  });

  it('stops at a single completion when there are no tool calls', async () => {
    openaiCreate.mockResolvedValue(assistantReply('just chatting'));

    const response = await chat(fakeCreateUserScopedClient(TOKEN), USER, 'hello');

    expect(openaiCreate).toHaveBeenCalledTimes(1);
    expect(response.reply).toBe('just chatting');
    expect(fakeDb.tasks).toHaveLength(0);
  });

  it('maps upstream 5xx failures to a safe AiServiceError (502)', async () => {
    openaiCreate.mockRejectedValue(
      Object.assign(new Error('upstream exploded: secret detail'), { status: 503 }),
    );

    await expect(
      chat(fakeCreateUserScopedClient(TOKEN), USER, 'hi'),
    ).rejects.toMatchObject({
      name: 'AiServiceError',
      statusCode: 502,
      message: 'The AI service is temporarily unavailable. Please try again.',
    });
  });

  it('maps timeouts to a safe AiServiceError (504)', async () => {
    const OpenAI = (await import('openai')).default;
    openaiCreate.mockRejectedValue(
      new OpenAI.APIConnectionTimeoutError({ message: 'Request timed out after 30000ms' }),
    );

    await expect(
      chat(fakeCreateUserScopedClient(TOKEN), USER, 'hi'),
    ).rejects.toMatchObject({
      name: 'AiServiceError',
      statusCode: 504,
      message: 'The AI service timed out. Please try again.',
    });
  });

  it('maps rate limiting to 429', async () => {
    openaiCreate.mockRejectedValue(
      Object.assign(new Error('rate limited'), { status: 429 }),
    );

    await expect(
      chat(fakeCreateUserScopedClient(TOKEN), USER, 'hi'),
    ).rejects.toMatchObject({
      name: 'AiServiceError',
      statusCode: 429,
      message: 'The AI service is rate-limited. Please try again shortly.',
    });
  });
});
