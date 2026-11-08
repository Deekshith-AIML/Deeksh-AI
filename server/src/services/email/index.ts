/**
 * services/email/index.ts
 * -----------------------
 * Email provider factory (Milestone 2).
 *
 * Selection order:
 *   1. NODE_ENV=test            → MockEmailProvider (never sends anything)
 *   2. RESEND_API_KEY + RESEND_FROM_EMAIL both set → ResendEmailProvider
 *   3. otherwise                → MockEmailProvider + a warning log, so a
 *      missing configuration degrades to "no email sent" instead of a
 *      crash — and the scheduler still records honest delivery status.
 *
 * SECURITY: this module is the only place that reads RESEND_API_KEY.
 * The key is handed to the provider constructor and never logged,
 * serialized, or exposed through any API response.
 */

import type { EmailProvider } from './types.js';
import { MockEmailProvider } from './mock.provider.js';
import { ResendEmailProvider } from './resend.provider.js';

let cached: EmailProvider | null = null;

/** Return the process-wide email provider (created on first use). */
export function getEmailProvider(): EmailProvider {
  if (cached) return cached;

  if (process.env.NODE_ENV === 'test') {
    cached = new MockEmailProvider();
    return cached;
  }

  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;

  if (apiKey && fromEmail) {
    cached = new ResendEmailProvider({ apiKey, fromEmail });
    console.log('[email] Provider: resend (sender configured)');
  } else {
    console.warn(
      '[email] RESEND_API_KEY / RESEND_FROM_EMAIL not configured — ' +
        'using the mock provider; NO emails will actually be delivered.',
    );
    cached = new MockEmailProvider();
  }
  return cached;
}

/** Replace the process-wide provider (tests only). */
export function setEmailProvider(provider: EmailProvider | null): void {
  cached = provider;
}

export { MockEmailProvider } from './mock.provider.js';
export { ResendEmailProvider } from './resend.provider.js';
export * from './types.js';
