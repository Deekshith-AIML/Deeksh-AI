/**
 * tests/helpers/geminiMocks.ts
 * ----------------------------
 * Builders for fake Gemini chat-completion responses (OpenAI-compatible
 * wire format). Used with the `vi.mock('openai')` factories so no real API
 * calls (and no API charges) are ever made by the test suite.
 */

interface ToolCallSpec {
  name: string;
  args: string;
  id?: string;
}

function usage() {
  return { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
}

/** A plain assistant text reply (no tool calls). */
export function assistantReply(content: string) {
  return {
    model: 'gemini-test',
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
    usage: usage(),
  };
}

/** An assistant message requesting one or more tool calls. */
export function assistantWithToolCalls(calls: ToolCallSpec[]) {
  return {
    model: 'gemini-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c, i) => ({
            id: c.id ?? `call_${i}`,
            type: 'function' as const,
            function: { name: c.name, arguments: c.args },
          })),
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: usage(),
  };
}

/** Convenience: a `create_task` tool call with JSON-stringified args. */
export function createTaskCall(args: Record<string, unknown>, id?: string) {
  return {
    name: 'create_task',
    args: JSON.stringify(args),
    ...(id ? { id } : {}),
  };
}
