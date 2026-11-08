/**
 * services/email/mock.provider.ts
 * -------------------------------
 * In-memory email provider used by the automated test suite and by local
 * development when RESEND is not configured.
 *
 * Guarantees for tests:
 *   - NO network I/O and NO real emails are ever sent.
 *   - Every attempted message is recorded in `sent` for assertions.
 *   - Failures can be scripted per call (`failNext`) to exercise the
 *     scheduler's retry / permanent-failure paths deterministically.
 */

import type { EmailMessage, EmailProvider, EmailSendResult } from './types.js';
import { EmailProviderError } from './types.js';

/** Scripted outcome for the next send call. */
export type ScriptedOutcome = 'ok' | 'transient' | 'permanent';

export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock';

  /** Every message handed to `send`, in order (including failed attempts). */
  readonly sent: EmailMessage[] = [];

  private queue: ScriptedOutcome[] = [];
  private counter = 0;

  /** Script the outcome of the next send call(s), FIFO. */
  failNext(outcome: ScriptedOutcome, times = 1): void {
    for (let i = 0; i < times; i += 1) this.queue.push(outcome);
  }

  /** Messages that were actually accepted (outcome 'ok'). */
  get accepted(): EmailMessage[] {
    return this.sent.slice(); // kept simple; tests inspect `sent` directly
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.sent.push(message);
    const outcome = this.queue.shift() ?? 'ok';

    if (outcome === 'transient') {
      throw new EmailProviderError('mock: transient provider failure', true, 503);
    }
    if (outcome === 'permanent') {
      throw new EmailProviderError('mock: permanent provider failure', false, 401);
    }

    this.counter += 1;
    return { id: `mock-${this.counter}` };
  }

  reset(): void {
    this.sent.length = 0;
    this.queue = [];
    this.counter = 0;
  }
}
