/**
 * tests/ai-reminder-tool.test.ts
 * ------------------------------
 * Milestone 2: the `reminder_at` / `recurrence` extension of the
 * Gemini `create_task` tool.
 *
 * Verifies:
 *   - a requested reminder is persisted with the server-resolved ISO time
 *   - a plain task creates NO reminder (a due date is not a reminder)
 *   - invalid / past reminder times fail with ZERO side effects
 *   - a reminder-insert failure is reported as an honest warning while
 *     the already-created task is preserved
 *   - weekly recurrence schedules only the next occurrence and says so
 *   - recurrence without a reminder time is an explicit error
 *   - task due_date and reminder_at remain separate values
 *   - repeated identical tool calls do not stack duplicate reminders
 *
 * Gemini is mocked via `vi.mock('openai')` — no API calls or charges.
 * The clock is frozen to Friday, 2026-10-23 09:30 Asia/Kolkata so the
 * resolved reminder timestamps are deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { openaiCreate, openaiConstructorCalls } = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  openaiConstructorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('openai', () => {
  class APIConnectionTimeoutError extends Error {}
  class APIError extends Error {}
  class FakeOpenAI {
    chat = { completions: { create: openaiCreate } };
    static APIConnectionTimeoutError = APIConnectionTimeoutError;
    static APIError = APIError;
    constructor(options?: Record<string, unknown>) {
      openaiConstructorCalls.push(options ?? {});
    }
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

import { chat } from '../src/services/ai.service.js';
import { setClock, resetClock } from '../src/services/date.service.js';
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
} from './helpers/geminiMocks.js';

const TOKEN = 'headerR.payloadR.signatureR';
const USER = '11111111-1111-4111-8111-111111111111';

/** Frozen clock: Friday 2026-10-23 09:30 IST. */
const FROZEN = '2026-10-23T09:30:00+05:30';

type Msg = { role: string; content?: string | null; tool_call_id?: string };

/** Tool messages present in a captured completion request (excludes the few-shot demo). */
function toolMessagesOf(callIndex: number): Msg[] {
  const call = openaiCreate.mock.calls[callIndex]?.[0] as { messages: Msg[] };
  return call.messages.filter(
    (m) => m.role === 'tool' && !String(m.tool_call_id ?? '').startsWith('call_demo'),
  );
}

function toolResult(callIndex = 1): Record<string, unknown> {
  return JSON.parse(String(toolMessagesOf(callIndex)[0]?.content));
}

/** The most recent tool result in a captured completion (last round wins). */
function lastToolResult(callIndex: number): Record<string, unknown> {
  const msgs = toolMessagesOf(callIndex);
  return JSON.parse(String(msgs[msgs.length - 1]?.content));
}

describe('create_task tool: reminders (Milestone 2)', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser(TOKEN, USER, 'alice@example.com');
    openaiCreate.mockReset();
    setClock({
      now: () => new Date(FROZEN),
      nowString: () => new Date(FROZEN).toISOString(),
    });
  });

  afterEach(() => {
    resetClock();
  });

  // --- Scenario: reminder created with the server-resolved ISO time --------

  it('creates a reminder with the resolved future ISO time when requested', async () => {
    openaiCreate
      .mockResolvedValueOnce(
        assistantWithToolCalls([
          createTaskCall({
            title: 'Call the dentist',
            reminder_at: 'tomorrow at 9 AM',
          }),
        ]),
      )
      .mockResolvedValueOnce(assistantReply('Reminder set for tomorrow 9 AM.'));

    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'remind me tomorrow at 9 AM');

    const result = toolResult();
    expect(result.success).toBe(true);
    expect(result.reminder).toBeTruthy();

    expect(fakeDb.tasks).toHaveLength(1);
    expect(fakeDb.reminders).toHaveLength(1);

    const reminder = fakeDb.reminders[0]!;
    expect(reminder.user_id).toBe(USER); // ownership from verified identity
    expect(reminder.task_id).toBe(fakeDb.tasks[0]!.id); // linked to the task
    expect(reminder.status).toBe('pending');
    expect(reminder.attempts).toBe(0);
    // 09:00 IST on 2026-10-24 = 03:30 UTC — resolved by the SERVER,
    // not by the model.
    expect(reminder.reminder_at).toBe('2026-10-24T03:30:00.000Z');
    expect((result.reminder as { reminder_at: string }).reminder_at).toBe(
      '2026-10-24T03:30:00.000Z',
    );
  });

  // --- Scenario: no reminder requested -> no reminder created ---------------

  it('does not create any reminder when the user only asks for a task', async () => {
    openaiCreate
      .mockResolvedValueOnce(
        assistantWithToolCalls([
          createTaskCall({ title: 'Buy groceries', due_date: '2026-10-30T18:00:00+05:30' }),
        ]),
      )
      .mockResolvedValueOnce(assistantReply('Task created.'));

    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'add buy groceries due Oct 30');

    const result = toolResult();
    expect(result.success).toBe(true);
    expect(result.reminder).toBeUndefined(); // no reminder claimed
    expect(fakeDb.tasks).toHaveLength(1);
    expect(fakeDb.reminders).toHaveLength(0); // due date ≠ reminder
  });

  // --- Scenario: invalid reminder time -> no side effects ------------------

  it('rejects an unparseable reminder time with zero side effects', async () => {
    openaiCreate
      .mockResolvedValueOnce(
        assistantWithUnparseableReminder(),
      )
      .mockResolvedValueOnce(assistantReply('Could not understand the time.'));

    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'remind me sometime soonish');

    const result = toolResult();
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/could not understand/i);
    expect(fakeDb.tasks).toHaveLength(0); // no orphan task
    expect(fakeDb.reminders).toHaveLength(0);
  });

  // --- Scenario: past reminder time -> no side effects ---------------------

  it('rejects a past reminder time with zero side effects', async () => {
    openaiCreate
      .mockResolvedValueOnce(
        assistantWithToolCalls([
          createTaskCall({ title: 'Late reminder', reminder_at: '2025-05-01T09:00:00+05:30' }),
        ]),
      )
      .mockResolvedValueOnce(assistantReply('That time has passed.'));

    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'remind me yesterday');

    const result = toolResult();
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/in the past/i);
    expect(fakeDb.tasks).toHaveLength(0);
    expect(fakeDb.reminders).toHaveLength(0);
  });

  // --- Scenario: reminder insert failure -> honest warning ------------------

  it('reports an honest warning when the reminder insert fails (task preserved)', async () => {
    injectDatabaseFailure('reminders', 'insert', 'simulated reminders outage');

    openaiCreate
      .mockResolvedValueOnce(
        assistantWithToolCalls([
          createTaskCall({ title: ' Fragile reminder ', reminder_at: 'tomorrow at 10 AM' }),
        ]),
      )
      .mockResolvedValueOnce(assistantReply('Task saved but reminder failed.'));

    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'remind me tomorrow at 10 AM');

    const result = toolResult();
    expect(result.success).toBe(true); // task WAS created
    expect(result.task).toBeTruthy();
    expect(result.warning).toMatch(/reminder could NOT be saved/i);
    expect(result.reminder).toBeUndefined(); // never claim a reminder exists

    expect(fakeDb.tasks).toHaveLength(1); // user's task not rolled back
    expect(fakeDb.reminders).toHaveLength(0);
  });

  // --- Scenario: weekly recurrence -> next occurrence + explicit note -------

  it('schedules only the next weekly occurrence and flags recurrence as unsupported', async () => {
    openaiCreate
      .mockResolvedValueOnce(
        assistantWithToolCalls([
          createTaskCall({
            title: 'Weekly review',
            reminder_at: 'monday at 8 AM',
            recurrence: 'weekly',
          }),
        ]),
      )
      .mockResolvedValueOnce(assistantReply('Next Monday scheduled; recurrence not supported.'));

    await chat(
      fakeCreateUserScopedClient(TOKEN),
      USER,
      'remind me every monday at 8 AM for weekly review',
    );

    const result = toolResult();
    expect(result.success).toBe(true);
    expect(String(result.note)).toMatch(/not supported yet/i);
    expect(String(result.note)).toMatch(/one-time/i);

    expect(fakeDb.reminders).toHaveLength(1); // ONLY the next occurrence
    // Frozen clock: Friday 2026-10-23 → next Monday 2026-10-26 08:00 IST
    // = 02:30 UTC.
    expect(fakeDb.reminders[0]!.reminder_at).toBe('2026-10-26T02:30:00.000Z');
  });

  // --- Scenario: recurrence without a reminder time -> explicit error -------

  it('rejects a recurrence request that has no reminder time', async () => {
    openaiCreate
      .mockResolvedValueOnce(
        assistantWithToolCalls([
          createTaskCall({ title: 'Recurring thing', recurrence: 'weekly' }),
        ]),
      )
      .mockResolvedValueOnce(assistantReply('When should it fire?'));

    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'every monday weekly thing');

    const result = toolResult();
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/without a reminder time/i);
    expect(fakeDb.tasks).toHaveLength(0);
    expect(fakeDb.reminders).toHaveLength(0);
  });

  // --- Scenario: due date and reminder remain separate ---------------------

  it('keeps due_date and reminder_at as separate values on the same task', async () => {
    openaiCreate
      .mockResolvedValueOnce(
        assistantWithToolCalls([
          createTaskCall({
            title: 'Project deadline',
            due_date: '2026-11-15T18:00:00+05:30',
            reminder_at: '2026-11-14T09:00:00+05:30',
          }),
        ]),
      )
      .mockResolvedValueOnce(assistantReply('Due Nov 15, reminder Nov 14.'));

    await chat(
      fakeCreateUserScopedClient(TOKEN),
      USER,
      'project due Nov 15, remind me Nov 14 at 9 AM',
    );

    const result = toolResult();
    expect(result.success).toBe(true);
    expect(fakeDb.tasks).toHaveLength(1);
    expect(fakeDb.reminders).toHaveLength(1);

    const task = fakeDb.tasks[0]!;
    const reminder = fakeDb.reminders[0]!;
    // 18:00 IST Nov 15 = 12:30 UTC; 09:00 IST Nov 14 = 03:30 UTC.
    expect(task.due_date).toBe('2026-11-15T12:30:00.000Z');
    expect(reminder.reminder_at).toBe('2026-11-14T03:30:00.000Z');
    expect(reminder.reminder_at).not.toBe(task.due_date);
    expect(reminder.task_id).toBe(task.id);
  });

  // --- Scenario: repeated tool calls do not stack reminders ----------------

  it('does not stack duplicate reminders for repeated identical tool calls', async () => {
    const args = { title: 'Standup prep', reminder_at: 'tomorrow at 8 AM' };

    openaiCreate
      .mockResolvedValueOnce(assistantWithToolCalls([createTaskCall(args)]))
      .mockResolvedValueOnce(assistantWithToolCalls([createTaskCall(args)]))
      .mockResolvedValueOnce(assistantReply('Already created.'));

    // Three rounds within one conversation: create → dedupe → final reply.
    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'remind me tomorrow at 8 AM');

    expect(fakeDb.tasks.length).toBeLessThanOrEqual(1);
    // Idempotency key (ai:taskId:iso) guarantees at most ONE reminder row.
    expect(fakeDb.reminders.length).toBeLessThanOrEqual(1);
    if (fakeDb.tasks.length === 1 && fakeDb.reminders.length === 1) {
      expect(fakeDb.reminders[0]!.task_id).toBe(fakeDb.tasks[0]!.id);
    }
  });

  it('schedules a reminder for a deduplicated task without duplicating it', async () => {
    const args = { title: 'Dupe check', reminder_at: 'in 2 hours' };

    openaiCreate
      .mockResolvedValueOnce(assistantWithToolCalls([createTaskCall(args)]))
      .mockResolvedValueOnce(assistantWithToolCalls([createTaskCall(args)]))
      .mockResolvedValueOnce(assistantReply('done'));

    await chat(fakeCreateUserScopedClient(TOKEN), USER, 'remind me in 2 hours');

    const first = toolResult(1);
    // Call index 2 carries BOTH tool results — the dedupe one is last.
    const second = lastToolResult(2);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.deduplicated).toBe(true);
    // Same task, same reminder — no second row of either.
    expect(fakeDb.tasks).toHaveLength(1);
    expect(fakeDb.reminders).toHaveLength(1);
  });
});

/** Helper: a create_task call whose reminder_at cannot be parsed. */
function assistantWithUnparseableReminder() {
  return assistantWithToolCalls([
    createTaskCall({ title: 'Vague reminder', reminder_at: 'sometime soonish' }),
  ]);
}
