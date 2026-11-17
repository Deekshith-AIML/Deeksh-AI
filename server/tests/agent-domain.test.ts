/**
 * M6 Phase 5 — Domain agent tests (Memory, Knowledge, Task, Scheduling).
 *
 * Covers: registry wiring of the four live agents, capability metadata
 * (approval / idempotency / availability policies), execution through the
 * EXISTING owner-scoped services, model-supplied id resolution, credential
 * rejection with zero side effects, natural-language reminder resolution,
 * duplicate/idempotent behavior, approval-gated destructive operations,
 * abort handling, and an end-to-end orchestrator run with the REAL
 * registry (no stub agents).
 *
 * OpenAI (Gemini-compatible endpoint) is mocked — no API calls or charges.
 * Supabase is the in-memory fake; embeddings auto-mock under NODE_ENV=test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { openaiCreate } = vi.hoisted(() => ({ openaiCreate: vi.fn() }));

vi.mock('openai', () => {
  class APIConnectionTimeoutError extends Error {}
  class APIError extends Error {}
  class FakeOpenAI {
    chat = { completions: { create: openaiCreate } };
    static APIConnectionTimeoutError = APIConnectionTimeoutError;
    static APIError = APIError;
    constructor(_options?: Record<string, unknown>) {}
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

import { createDomainRegistry, registerDomainAgents } from '../src/agents/register.js';
import { AgentRegistry } from '../src/agents/registry/agent.registry.js';
import { memoryAgent } from '../src/agents/memory/memory.agent.js';
import { taskAgent } from '../src/agents/task/task.agent.js';
import { AGENT_ERROR_CODES, AgentError } from '../src/agents/shared/index.js';
import type { AgentContext, AgentResult } from '../src/agents/shared/index.js';
import { executeObjective } from '../src/agents/orchestrator/orchestrator.service.js';
import * as store from '../src/agents/workflow/workflow.store.js';
import { createMemory } from '../src/services/memory.service.js';
import { createTask } from '../src/services/task.service.js';
import { createReminder } from '../src/services/reminder.service.js';
import { resetClock, setClock } from '../src/services/date.service.js';
import {
  fakeCreateUserScopedClient,
  fakeDb,
  forceMatchSimilarity,
  registerUser,
  resetFakeSupabase,
} from './helpers/fakeSupabase.js';
import type { FakeDocument, FakeDocumentChunk } from './helpers/fakeSupabase.js';
import { assistantReply } from './helpers/geminiMocks.js';

const TOKEN = 'headerP.payloadP.signatureP';
const TOKEN_O = 'token-o';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
/** Frozen clock: Friday 2026-10-23 09:30 IST (matches reminder-resolution). */
const FROZEN = '2026-10-23T09:30:00+05:30';

let registry: AgentRegistry;
let client: ReturnType<typeof fakeCreateUserScopedClient>;

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userId: USER,
    client,
    runId: 'run-test',
    stepId: 'step-test',
    deadline: Date.now() + 15_000,
    ...overrides,
  };
}

/** Dispatch exactly like the orchestrator: registry gate, then execute. */
async function runOp(
  agent: string,
  operation: string,
  args: Record<string, unknown>,
  context: AgentContext = makeContext(),
): Promise<AgentResult> {
  const res = registry.validatePlanStep(agent, operation, args);
  return res.agent.execute({ operation, args: res.args as Record<string, unknown> }, context);
}

function seedDocument(
  id: string,
  userId: string,
  opts: Partial<Pick<FakeDocument, 'original_filename' | 'extension' | 'status'>> = {},
): FakeDocument {
  const extension = opts.extension ?? 'pdf';
  const doc: FakeDocument = {
    id,
    user_id: userId,
    original_filename: opts.original_filename ?? 'guide.pdf',
    storage_filename: 'storage.bin',
    extension,
    mime_type:
      extension === 'txt'
        ? 'text/plain'
        : extension === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/pdf',
    file_size: 1000,
    content_hash: 'a'.repeat(64),
    storage_path: `${userId}/${id}/storage.bin`,
    status: opts.status ?? 'ready',
    page_count: 5,
    text_char_count: 1000,
    chunk_count: 1,
    extraction_metadata: {},
    error_message: null,
    deletion_attempts: 0,
    deletion_error: null,
    processing_started_at: null,
    processing_completed_at: null,
    created_at: new Date(1_700_000_000_000).toISOString(),
    updated_at: new Date(1_700_000_000_000).toISOString(),
  };
  fakeDb.documents.push(doc);
  return doc;
}

function seedChunk(id: string, doc: FakeDocument, content: string): FakeDocumentChunk {
  const chunk: FakeDocumentChunk = {
    id,
    document_id: doc.id,
    user_id: doc.user_id,
    chunk_index: 0,
    content,
    embedding: Array.from({ length: 1536 }, () => 0.5),
    embedding_provider: 'gemini',
    embedding_model_version: 'gemini-embedding-2',
    embedding_dimensions: 1536,
    page_start: 4,
    page_end: 4,
    heading: 'Skills',
    section_path: '2 > Skills',
    paragraph_start: 0,
    paragraph_end: 0,
    char_start: 0,
    char_end: content.length,
    token_estimate: 10,
    created_at: new Date(1_700_000_000_000).toISOString(),
  };
  fakeDb.document_chunks.push(chunk);
  return chunk;
}

function jsonReply(obj: unknown) {
  return assistantReply(JSON.stringify(obj));
}

beforeEach(() => {
  resetFakeSupabase();
  registerUser(TOKEN, USER, 'p@example.com');
  registerUser(TOKEN_O, OTHER, 'o@example.com');
  client = fakeCreateUserScopedClient(TOKEN);
  registry = createDomainRegistry();
  openaiCreate.mockReset();
});

afterEach(() => {
  resetClock();
});

// ---------------------------------------------------------------------------
// Registration and capability policy
// ---------------------------------------------------------------------------

describe('M6 Phase 5 registration', () => {
  it('registers the four live agents with 12 available capabilities', () => {
    expect(registry.listAgents().sort()).toEqual(['knowledge', 'memory', 'scheduling', 'task']);
    const caps = registry.listCapabilities({ includeUnavailable: true });
    expect(caps).toHaveLength(12);
    // Every Phase 5 capability is backed by a REAL service — nothing fake.
    expect(caps.every((c) => c.available)).toBe(true);
    expect(registry.listCapabilities()).toHaveLength(12);
  });

  it('every declared (agent, operation) resolves to its capability', () => {
    for (const cap of registry.listCapabilities({ includeUnavailable: true })) {
      for (const op of cap.operations) {
        const found = registry.findCapabilityFor(cap.agent, op);
        expect(found?.name).toBe(cap.name);
      }
    }
  });

  it('rejects operations that are not registered (model cannot invent functions)', () => {
    expect(() => registry.validatePlanStep('task', 'drop_all', {})).toThrow(AgentError);
    expect(() => registry.validatePlanStep('research', 'web_search', {})).toThrow(
      /No registered capability/,
    );
  });

  it('gates exactly the destructive operations behind approval', () => {
    const gated = registry
      .listCapabilities({ includeUnavailable: true })
      .filter((c) => c.approvalRequired)
      .map((c) => c.name)
      .sort();
    expect(gated).toEqual(['scheduling.cancel', 'task.delete']);
  });

  it('marks only genuinely retry-safe capabilities idempotent', () => {
    const notIdempotent = registry
      .listCapabilities({ includeUnavailable: true })
      .filter((c) => !c.idempotent)
      .map((c) => c.name)
      .sort();
    expect(notIdempotent).toEqual([
      'memory.create',
      'scheduling.cancel',
      'scheduling.create',
      'task.delete',
    ]);
  });

  it('strips identity fields from args even if they reach the capability schema', () => {
    const { args } = registry.validatePlanStep('task', 'create', {
      title: 'Legit task',
      user_id: 'evil-user',
      owner_id: 'evil-owner',
    });
    expect(args).toHaveProperty('title', 'Legit task');
    expect(args).not.toHaveProperty('user_id');
    expect(args).not.toHaveProperty('owner_id');
  });

  it('refuses to register the same agents twice (startup failure, not silent gap)', () => {
    expect(() => registerDomainAgents(registry)).toThrow(/already registered/);
  });
});

// ---------------------------------------------------------------------------
// Memory agent
// ---------------------------------------------------------------------------

describe('memory agent', () => {
  it('retrieve returns only the owner\'s active memories with bounded excerpts', async () => {
    await createMemory(client, USER, {
      content: `Dark mode preferences. ${'x'.repeat(300)}`,
      category: 'user_preference',
      confidence: 'high',
    });
    const otherClient = fakeCreateUserScopedClient(TOKEN_O);
    await createMemory(otherClient, OTHER, {
      content: 'Other owner private plans',
      category: 'personal_fact',
      confidence: 'high',
    });

    const res = await runOp('memory', 'retrieve', { query: 'dark mode preferences' });
    expect(res.status).toBe('ok');
    const out = res.output as unknown as {
      count: number;
      memories: Array<{ id: string; excerpt: string }>;
    };
    expect(out.count).toBe(1);
    expect(out.memories[0]?.id).toBe(fakeDb.memories.find((m) => m.user_id === USER)?.id);
    expect(out.memories[0]!.excerpt.length).toBeLessThanOrEqual(200);
  });

  it('retrieve honors the category filter', async () => {
    await createMemory(client, USER, {
      content: 'Prefers dark mode',
      category: 'user_preference',
      confidence: 'high',
    });
    await createMemory(client, USER, {
      content: 'Thesis chapter 3 outline',
      category: 'project',
      confidence: 'high',
    });

    const res = await runOp('memory', 'retrieve', { query: 'outline', category: 'project' });
    expect(res.status).toBe('ok');
    const out = res.output as unknown as {
      count: number;
      memories: Array<{ excerpt: string }>;
    };
    expect(out.count).toBe(1);
    expect(out.memories[0]?.excerpt).toContain('Thesis');
  });

  it('create persists an active memory for the verified owner', async () => {
    const res = await runOp('memory', 'create', {
      content: 'User prefers window seats',
      category: 'user_preference',
    });
    expect(res.status).toBe('ok');
    expect(res.output).toMatchObject({ created: true });
    expect(fakeDb.memories).toHaveLength(1);
    const row = fakeDb.memories[0]!;
    expect(row.user_id).toBe(USER);
    expect(row.status).toBe('active'); // explicit user request → high confidence
    expect(Array.isArray((row as unknown as Record<string, unknown>).embedding)).toBe(true);
  });

  it('an identical repeat create returns the existing memory without a duplicate row', async () => {
    const first = await runOp('memory', 'create', {
      content: 'Loves rooftop cafes',
      category: 'user_preference',
    });
    // Force the fake's similarity above the service's duplicate line (0.92).
    forceMatchSimilarity(0.95);
    const second = await runOp('memory', 'create', {
      content: 'Loves rooftop cafes',
      category: 'user_preference',
    });
    forceMatchSimilarity(null);

    expect(first.output).toMatchObject({ created: true });
    expect(second.output).toMatchObject({ created: false });
    expect((second.output as { memory_id: string }).memory_id).toBe(
      (first.output as { memory_id: string }).memory_id,
    );
    expect(fakeDb.memories).toHaveLength(1);
  });

  it('credential-shaped content is rejected with zero side effects', async () => {
    const res = await runOp('memory', 'create', {
      content: 'my password is 12345',
      category: 'other',
    });
    expect(res.status).toBe('failed');
    expect(res.error?.code).toBe(AGENT_ERROR_CODES.INVALID_INPUT);
    expect(res.error?.message).toContain('Credential');
    expect(fakeDb.memories).toHaveLength(0);
  });

  it('the agent itself re-validates input and rejects bad args / unknown ops', async () => {
    const bad = await memoryAgent.execute(
      { operation: 'create', args: { content: '' } },
      makeContext(),
    );
    expect(bad.status).toBe('failed');
    expect(bad.error?.code).toBe(AGENT_ERROR_CODES.INVALID_INPUT);

    const unknownOp = await memoryAgent.execute(
      { operation: 'summarize', args: {} },
      makeContext(),
    );
    expect(unknownOp.status).toBe('failed');
    expect(unknownOp.error?.code).toBe(AGENT_ERROR_CODES.CAPABILITY_FORBIDDEN);
  });

  it('an aborted run signal short-circuits before any service call', async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await runOp(
      'memory',
      'retrieve',
      { query: 'anything' },
      makeContext({ signal: controller.signal }),
    );
    expect(res.status).toBe('failed');
    expect(res.error?.code).toBe(AGENT_ERROR_CODES.CANCELLED);
    expect(fakeDb.memories).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Knowledge agent
// ---------------------------------------------------------------------------

describe('knowledge agent', () => {
  it('list returns only the owner\'s documents and honors the type filter', async () => {
    seedDocument('doc-pdf', USER, { original_filename: 'guide.pdf', extension: 'pdf' });
    seedDocument('doc-txt', USER, { original_filename: 'notes.txt', extension: 'txt' });
    seedDocument('doc-foreign', OTHER, { original_filename: 'foreign.pdf', extension: 'pdf' });

    const all = await runOp('knowledge', 'list', {});
    expect(all.status).toBe('ok');
    expect((all.output as unknown as { count: number }).count).toBe(2);

    const txt = await runOp('knowledge', 'list', { type: 'txt' });
    const out = txt.output as unknown as { documents: Array<{ id: string; filename: string }> };
    expect(out.documents.map((d) => d.id)).toEqual(['doc-txt']);
    expect(out.documents[0]?.filename).toBe('notes.txt');
  });

  it('search returns bounded passages with document metadata', async () => {
    const doc = seedDocument('doc-1', USER);
    seedChunk('chunk-1', doc, 'Skills: Python, SQL, data visualization');
    seedChunk('chunk-2', doc, 'Tools: Jupyter, Tableau, Power BI');

    const res = await runOp('knowledge', 'search', {
      query: 'python skills',
      threshold: 0.1,
    });
    expect(res.status).toBe('ok');
    const out = res.output as unknown as {
      count: number;
      chunks: Array<{ chunk_id: string; document_id: string; filename: string; excerpt: string }>;
    };
    expect(out.count).toBe(2);
    expect(out.chunks.every((c) => c.document_id === 'doc-1')).toBe(true);
    expect(out.chunks[0]?.filename).toBe('guide.pdf');
    expect(out.chunks.every((c) => c.excerpt.length <= 300)).toBe(true);
  });

  it('a foreign document id is an unresolved reference — no content leaks', async () => {
    const foreign = seedDocument('11111111-1111-4111-8111-111111111111', OTHER, {
      original_filename: 'foreign.pdf',
    });
    seedChunk('f-chunk', foreign, 'confidential foreign content');

    const res = await runOp('knowledge', 'search', {
      query: 'confidential',
      document_ids: ['11111111-1111-4111-8111-111111111111'],
      threshold: 0.1,
    });
    expect(res.status).toBe('failed');
    expect(res.error?.code).toBe(AGENT_ERROR_CODES.UNRESOLVED_REFERENCE);
    expect(JSON.stringify(res.output ?? {})).not.toContain('confidential');
    expect(JSON.stringify(res)).not.toContain('confidential foreign content');
  });

  it('a not-yet-ready own document fails honestly instead of pretending "no results"', async () => {
    seedDocument('22222222-2222-4222-8222-222222222222', USER, { status: 'processing' });

    const res = await runOp('knowledge', 'search', {
      query: 'anything',
      document_ids: ['22222222-2222-4222-8222-222222222222'],
    });
    expect(res.status).toBe('failed');
    expect(res.error?.code).toBe(AGENT_ERROR_CODES.INVALID_INPUT);
    expect(res.error?.message).toContain('not ready');
  });
});

// ---------------------------------------------------------------------------
// Task agent
// ---------------------------------------------------------------------------

describe('task agent', () => {
  it('list returns the owner\'s tasks with status filters', async () => {
    await createTask(client, USER, { title: 'Write report', status: 'todo', priority: 'high' });
    await createTask(client, USER, { title: 'Ship release', status: 'done' });

    const all = await runOp('task', 'list', {});
    expect((all.output as unknown as { count: number }).count).toBe(2);

    const done = await runOp('task', 'list', { status: 'done' });
    expect((done.output as unknown as { count: number }).count).toBe(1);
  });

  it('create persists a task owned by the verified user', async () => {
    const res = await runOp('task', 'create', { title: 'Book flights', priority: 'high' });
    expect(res.status).toBe('ok');
    expect(res.output).toMatchObject({ created: true });
    expect(fakeDb.tasks).toHaveLength(1);
    expect(fakeDb.tasks[0]!.user_id).toBe(USER);
    expect(fakeDb.tasks[0]!.priority).toBe('high');
  });

  it('an identical repeat create returns the existing task (no duplicate rows)', async () => {
    const first = await runOp('task', 'create', { title: 'Same task', due_date: null });
    const second = await runOp('task', 'create', { title: 'same task' });
    expect(first.output).toMatchObject({ created: true });
    expect(second.output).toMatchObject({ created: false });
    expect(fakeDb.tasks).toHaveLength(1);
  });

  it('update applies to the owner and rejects a patch-less request', async () => {
    const created = await runOp('task', 'create', { title: 'Update me' });
    const taskId = (created.output as unknown as { task_id: string }).task_id;

    const res = await runOp('task', 'update', { task_id: taskId, status: 'done' });
    expect(res.status).toBe('ok');
    expect(fakeDb.tasks[0]!.status).toBe('done');

    // Registry gate rejects a patch-less update before dispatch…
    expect(() => registry.validatePlanStep('task', 'update', { task_id: taskId })).toThrow(
      AgentError,
    );
    // …and the agent itself re-validates when called directly.
    const bare = await taskAgent.execute({ operation: 'update', args: { task_id: taskId } }, makeContext());
    expect(bare.status).toBe('failed');
    expect(bare.error?.code).toBe(AGENT_ERROR_CODES.INVALID_INPUT);
  });

  it('a foreign task id cannot be updated (unresolved reference, row untouched)', async () => {
    const otherClient = fakeCreateUserScopedClient(TOKEN_O);
    const foreign = await createTask(otherClient, OTHER, { title: 'Foreign task' });

    const res = await runOp('task', 'update', { task_id: foreign.id, title: 'Hijacked' });
    expect(res.status).toBe('failed');
    expect(res.error?.code).toBe(AGENT_ERROR_CODES.UNRESOLVED_REFERENCE);
    expect(fakeDb.tasks.find((t) => t.id === foreign.id)?.title).toBe('Foreign task');
  });

  it('delete removes the owner\'s task; a foreign id is refused and untouched', async () => {
    const mine = await createTask(client, USER, { title: 'Mine' });
    const ok = await runOp('task', 'delete', { task_id: mine.id });
    expect(ok.status).toBe('ok');
    expect(fakeDb.tasks).toHaveLength(0);

    const otherClient = fakeCreateUserScopedClient(TOKEN_O);
    const theirs = await createTask(otherClient, OTHER, { title: 'Theirs' });
    const refused = await runOp('task', 'delete', { task_id: theirs.id });
    expect(refused.status).toBe('failed');
    expect(refused.error?.code).toBe(AGENT_ERROR_CODES.UNRESOLVED_REFERENCE);
    expect(fakeDb.tasks.some((t) => t.id === theirs.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scheduling agent
// ---------------------------------------------------------------------------

describe('scheduling agent', () => {
  it('list returns only the owner\'s reminders', async () => {
    await createReminder(client, USER, {
      title: 'Standup',
      reminder_at: '2027-03-01T09:00:00+05:30',
    });
    const otherClient = fakeCreateUserScopedClient(TOKEN_O);
    await createReminder(otherClient, OTHER, {
      title: 'Other standup',
      reminder_at: '2027-03-02T09:00:00+05:30',
    });

    const res = await runOp('scheduling', 'list', {});
    expect(res.status).toBe('ok');
    expect((res.output as unknown as { count: number }).count).toBe(1);
  });

  it('create resolves a natural-language phrase to the server-authoritative future ISO time', async () => {
    setClock({
      now: () => new Date(FROZEN),
      nowString: () => new Date(FROZEN).toISOString(),
    });
    const res = await runOp('scheduling', 'create', {
      title: 'Call dentist',
      reminder_at: 'tomorrow at 9 AM',
    });
    expect(res.status).toBe('ok');
    expect(res.output).toMatchObject({
      created: true,
      reminder_at: '2026-10-24T03:30:00.000Z', // Oct 24, 09:00 IST — resolved by date.service
    });
    expect(fakeDb.reminders).toHaveLength(1);
    expect(fakeDb.reminders[0]!.user_id).toBe(USER);
    expect(fakeDb.reminders[0]!.status).toBe('pending');
  });

  it('an invalid/past reminder time is rejected with zero side effects', async () => {
    const res = await runOp('scheduling', 'create', {
      title: 'Too late',
      reminder_at: '2020-01-01T09:00:00+05:30',
    });
    expect(res.status).toBe('failed');
    expect(res.error?.code).toBe(AGENT_ERROR_CODES.INVALID_INPUT);
    expect(fakeDb.reminders).toHaveLength(0);
  });

  it('a foreign task_id cannot be attached to a new reminder', async () => {
    const otherClient = fakeCreateUserScopedClient(TOKEN_O);
    const foreignTask = await createTask(otherClient, OTHER, { title: 'Foreign task' });

    const res = await runOp('scheduling', 'create', {
      title: 'My reminder',
      task_id: foreignTask.id,
      reminder_at: '2027-03-01T09:00:00+05:30',
    });
    expect(res.status).toBe('failed');
    expect(res.error?.code).toBe(AGENT_ERROR_CODES.UNRESOLVED_REFERENCE);
    expect(fakeDb.reminders).toHaveLength(0);
  });

  it('repeating a create with the same idempotency key never stacks duplicates', async () => {
    const args = {
      title: 'Daily check-in',
      reminder_at: '2027-03-01T09:00:00+05:30',
      idempotency_key: 'plan-1',
    };
    const first = await runOp('scheduling', 'create', args);
    const second = await runOp('scheduling', 'create', args);
    expect(first.output).toMatchObject({ created: true });
    expect(second.output).toMatchObject({ created: false });
    expect(fakeDb.reminders).toHaveLength(1);
  });

  it('update reschedules the owner\'s pending reminder', async () => {
    const seeded = await createReminder(client, USER, {
      title: 'Reschedule me',
      reminder_at: '2027-06-01T09:00:00+05:30',
    });
    const res = await runOp('scheduling', 'update', {
      reminder_id: seeded.reminder.id,
      reminder_at: '2027-07-01T10:00:00+05:30',
    });
    expect(res.status).toBe('ok');
    const newTime = (res.output as unknown as { reminder_at: string }).reminder_at;
    expect(new Date(newTime).getTime()).toBe(new Date('2027-07-01T10:00:00+05:30').getTime());
  });

  it('a foreign reminder id cannot be rescheduled (row untouched)', async () => {
    const otherClient = fakeCreateUserScopedClient(TOKEN_O);
    const foreign = await createReminder(otherClient, OTHER, {
      title: 'Other reminder',
      reminder_at: '2027-06-01T09:00:00+05:30',
    });
    const before = foreign.reminder.reminder_at;

    const res = await runOp('scheduling', 'update', {
      reminder_id: foreign.reminder.id,
      reminder_at: '2027-08-01T10:00:00+05:30',
    });
    expect(res.status).toBe('failed');
    expect(res.error?.code).toBe(AGENT_ERROR_CODES.UNRESOLVED_REFERENCE);
    expect(fakeDb.reminders.find((r) => r.id === foreign.reminder.id)?.reminder_at).toBe(before);
  });

  it('cancel works once, reports an honest conflict on repeat, and cannot touch foreign rows', async () => {
    const mine = await createReminder(client, USER, {
      title: 'Cancel me',
      reminder_at: '2027-03-01T09:00:00+05:30',
    });
    const ok = await runOp('scheduling', 'cancel', { reminder_id: mine.reminder.id });
    expect(ok.status).toBe('ok');
    expect(fakeDb.reminders[0]!.status).toBe('cancelled');

    const again = await runOp('scheduling', 'cancel', { reminder_id: mine.reminder.id });
    expect(again.status).toBe('failed');
    expect(again.error?.code).toBe(AGENT_ERROR_CODES.EXECUTION_FAILED);
    expect(again.error?.message).toContain('cancelled');

    const otherClient = fakeCreateUserScopedClient(TOKEN_O);
    const foreign = await createReminder(otherClient, OTHER, {
      title: 'Other reminder',
      reminder_at: '2027-03-02T09:00:00+05:30',
    });
    const refused = await runOp('scheduling', 'cancel', { reminder_id: foreign.reminder.id });
    expect(refused.status).toBe('failed');
    expect(refused.error?.code).toBe(AGENT_ERROR_CODES.UNRESOLVED_REFERENCE);
    expect(fakeDb.reminders.find((r) => r.id === foreign.reminder.id)?.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: REAL agents through the orchestrator
// ---------------------------------------------------------------------------

describe('orchestrator end-to-end with the real registry', () => {
  it('executes a memory → task plan and verifies both steps durably', async () => {
    openaiCreate.mockResolvedValueOnce(
      jsonReply({
        objective: 'Remember preferences and track a follow-up',
        steps: [
          {
            stepKey: 'lookup',
            agent: 'memory',
            operation: 'retrieve',
            args: { query: 'user preferences' },
          },
          {
            stepKey: 'record',
            agent: 'task',
            operation: 'create',
            args: { title: 'Apply saved preferences' },
            dependsOn: ['lookup'],
          },
        ],
      }),
    );

    const result = await executeObjective(
      client,
      USER,
      'remember my preferences and make a follow-up task',
      registry,
    );

    expect(result.status).toBe('completed');
    expect(result.outcomes.map((o) => o.status)).toEqual(['completed', 'completed']);
    expect(openaiCreate).toHaveBeenCalledTimes(1);
    expect(fakeDb.tasks).toHaveLength(1);
    expect(fakeDb.tasks[0]!.user_id).toBe(USER);

    // Durable state matches the claim.
    const run = await store.getRunOrThrow(client, USER, result.runId);
    expect(run.status).toBe('completed');
    const steps = await store.listSteps(client, USER, result.runId);
    expect(steps.every((s) => s.status === 'completed')).toBe(true);
  });

  it('pauses at the approval-gated delete step without removing anything', async () => {
    const task = await createTask(client, USER, { title: 'Stale task' });
    openaiCreate.mockResolvedValueOnce(
      jsonReply({
        objective: 'remove the stale task',
        steps: [
          {
            stepKey: 'remove',
            agent: 'task',
            operation: 'delete',
            args: { task_id: task.id },
          },
        ],
      }),
    );

    const result = await executeObjective(client, USER, 'delete the stale task', registry);

    expect(result.status).toBe('waiting_approval');
    expect(result.awaitingApproval).toBe(true);
    expect(fakeDb.tasks).toHaveLength(1); // nothing was removed
    const steps = await store.listSteps(client, USER, result.runId);
    expect(steps[0]?.status).toBe('waiting_approval');
    expect(result.response).toContain('approval');
  });

  it('rejects a plan step for an unregistered capability (honest failure, nothing runs)', async () => {
    openaiCreate.mockResolvedValueOnce(
      jsonReply({
        objective: 'research the web',
        steps: [{ stepKey: 'search', agent: 'research', operation: 'web_search' }],
      }),
    );

    await expect(
      executeObjective(client, USER, 'research something online', registry),
    ).rejects.toThrow(AgentError);

    const runs = await store.listRuns(client, USER);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error_code).toBe('INVALID_PLAN');
    expect(fakeDb.tasks).toHaveLength(0);
  });
});
