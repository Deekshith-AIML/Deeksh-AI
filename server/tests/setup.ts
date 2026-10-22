/**
 * tests/setup.ts
 * --------------
 * Vitest setup file — runs once before each test file.
 *
 * Provides benign environment variables so that modules with fail-fast
 * env validation (supabase.service, ai.service) can be imported even in
 * environments where no real `.env` exists. Real credentials are NEVER
 * required by the test suite: Supabase and OpenAI are replaced by test
 * doubles (see helpers/fakeSupabase.ts and the `vi.mock('openai')` blocks).
 */

process.env.NODE_ENV = 'test';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key-not-a-real-secret';
process.env.OPENAI_API_KEY ??= 'test-openai-key-not-a-real-secret';
process.env.OPENAI_MODEL ??= 'gpt-test';

process.env.PORT ??= '3999';
process.env.CORS_ORIGIN ??= 'http://localhost:3000';
