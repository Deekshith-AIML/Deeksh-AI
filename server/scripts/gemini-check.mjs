/**
 * scripts/gemini-check.mjs
 * ------------------------
 * Safe live check of the Gemini OpenAI-compatible endpoint using the same
 * client options and payload shapes as src/services/ai.service.ts.
 *
 * Prints ONLY: model, base URL, key presence/shape booleans, HTTP status,
 * error codes and redacted messages. API keys are never printed.
 *
 * Usage: node scripts/gemini-check.mjs
 */
import 'dotenv/config';
import OpenAI from 'openai';

const redact = (s) =>
  String(s).replace(/(AIza[0-9A-Za-z_-]{8,}|sk-[A-Za-z0-9_-]{8,})/g, '[redacted]');

const baseURL =
  process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai/';
const model = process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';
const apiKey = process.env.GEMINI_API_KEY;

console.log(
  JSON.stringify(
    {
      model,
      baseURL,
      keyConfigured: Boolean(apiKey),
      keyShapeGoogleAIza: /^AIza/.test(apiKey ?? ''),
      keyLengthBucket: apiKey ? `${Math.floor(apiKey.length / 10) * 10}±10 chars` : 'absent',
    },
    null,
    2,
  ),
);

if (!apiKey) {
  console.log('RESULT: GEMINI_API_KEY missing — aborting before any request.');
  process.exit(1);
}

const client = new OpenAI({ apiKey, baseURL, timeout: 30_000, maxRetries: 0 });

// --- 1. Plain completion (no tools) ----------------------------------------
try {
  const r = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: CHITTI GEMINI TEST OK' }],
    temperature: 0.3,
  });
  console.log(
    'PLAIN_OK',
    JSON.stringify({
      model: r.model,
      reply: r.choices?.[0]?.message?.content,
      usage: r.usage,
    }),
  );
} catch (e) {
  console.log(
    'PLAIN_FAIL',
    JSON.stringify({
      status: e?.status,
      code: redact(e?.code ?? ''),
      type: redact(e?.type ?? ''),
      message: redact(e?.message),
    }),
  );
}

// --- 2. Exact production tool-calling shape --------------------------------
const createTaskTool = {
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

try {
  const r = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: 'You are TaskMate, a task assistant. Use create_task when asked.' },
      { role: 'user', content: 'Create a task called Test Gemini wiring' },
    ],
    tools: [createTaskTool],
    tool_choice: 'auto',
    temperature: 0.3,
  });
  const msg = r.choices?.[0]?.message;
  console.log(
    'TOOLS_OK',
    JSON.stringify({
      model: r.model,
      finish_reason: r.choices?.[0]?.finish_reason,
      reply: msg?.content ?? null,
      tool_calls: msg?.tool_calls?.map((t) => ({
        id: t.id,
        name: t.function?.name,
        args: t.function?.arguments,
      })),
      usage: r.usage,
    }),
  );
} catch (e) {
  console.log(
    'TOOLS_FAIL',
    JSON.stringify({
      status: e?.status,
      code: redact(e?.code ?? ''),
      type: redact(e?.type ?? ''),
      message: redact(e?.message),
    }),
  );
}
