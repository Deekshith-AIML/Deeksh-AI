/**
 * worker.ts
 * ---------
 * Separate, persistent background scheduler process (Milestone 2).
 *
 * Run with:  npm run worker        (tsx src/worker.ts)
 *            npm run worker:dev    (tsx watch)
 *            npm start:worker      (built dist, production)
 *
 * WHY A SEPARATE PROCESS:
 * The scheduler must keep checking for due reminders even while the API
 * server is busy, deploying, or restarted independently — and multiple
 * replicas must be able to run without double-sending. All scheduling
 * state lives in PostgreSQL (due time, attempts, claims), so this process
 * is stateless: killing it loses nothing, and starting a second one is
 * safe (SKIP LOCKED claim).
 *
 * PRIVILEGES:
 * Uses SUPABASE_SERVICE_ROLE_KEY (via createAdminClient) because it must
 * read reminders across ALL users and write delivery status — something
 * RLS-scoped user clients cannot do. This is the only production code
 * path that uses the admin client, and it never serves HTTP traffic.
 *
 * EMAIL:
 * Uses the provider factory: Resend when RESEND_API_KEY +
 * RESEND_FROM_EMAIL are configured, otherwise a mock that sends nothing
 * (with a warning). NODE_ENV=test always forces the mock.
 *
 * SHUTDOWN:
 * SIGINT/SIGTERM → stop the timer, await the in-flight tick, exit 0.
 */

import 'dotenv/config';
import { createAdminClient } from './services/supabase.service.js';
import { getEmailProvider } from './services/email/index.js';
import { startScheduler } from './scheduler/reminder.worker.js';
import { startExtractionScheduler } from './workers/extraction.scheduler.js';

function main(): void {
  const client = createAdminClient(); // throws if SUPABASE_SERVICE_ROLE_KEY missing
  const email = getEmailProvider();

  const reminderHandle = startScheduler({ client, email });
  const extractionHandle = startExtractionScheduler({ client });

  console.log(
    `[worker] Reminder scheduler started (email provider: ${email.name}, ` +
      `interval 60s).`,
  );
  console.log('[worker] Memory-extraction scheduler started (interval 10s).');

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received — waiting for in-flight work…`);
    Promise.allSettled([reminderHandle.stop(), extractionHandle.stop()])
      .then((results) => {
        const rejected = results.filter((r) => r.status === 'rejected');
        if (rejected.length > 0) {
          console.error('[worker] shutdown error:', rejected);
          process.exit(1);
        }
        console.log('[worker] stopped cleanly.');
        process.exit(0);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
