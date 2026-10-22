/**
 * vitest.config.ts
 * ----------------
 * Test runner configuration for the backend security suite.
 *
 * Tests run in a plain Node environment against the real Express app
 * (src/app.ts) with Supabase and OpenAI replaced by test doubles, so they
 * never contact external services and never incur OpenAI charges.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Fail loudly on unhandled rejections inside tests.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});
