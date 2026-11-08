/**
 * services/email/resend.provider.ts
 * ---------------------------------
 * Resend email provider (Milestone 2).
 *
 * Talks to Resend's REST API (`POST https://api.resend.com/emails`) with
 * `Authorization: Bearer <RESEND_API_KEY>` — the key is passed in by the
 * factory (index.ts) and is NEVER logged, returned to clients, or sent to
 * the frontend.
 *
 * Error classification (drives scheduler retries):
 *   - network failure / timeout / 429 / 5xx → transient (EmailProviderError.transient = true)
 *   - any other 4xx (bad key, bad from-address, invalid recipient)
 *     → permanent (retrying cannot succeed)
 *
 * The HTTP response body is deliberately NOT included in thrown errors —
 * upstream bodies can echo request details we don't want in logs.
 */

import type { EmailMessage, EmailProvider, EmailSendResult } from './types.js';
import { EmailProviderError } from './types.js';

/** Resend API endpoint. Overridable for tests / proxies. */
export const RESEND_API_ENDPOINT = 'https://api.resend.com/emails';

export interface ResendConfig {
  apiKey: string;
  /** Verified sender, e.g. "TaskMate <reminders@yourdomain.com>". */
  fromEmail: string;
  endpoint?: string;
  /** Injectable for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';

  private readonly apiKey: string;
  private readonly fromEmail: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: ResendConfig) {
    this.apiKey = config.apiKey;
    this.fromEmail = config.fromEmail;
    this.endpoint = config.endpoint ?? RESEND_API_ENDPOINT;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          // Bearer auth — the key never appears in URLs or logs.
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Network layer failure (DNS, refused connection, timeout) → transient.
      const detail = err instanceof Error ? err.name : 'network error';
      throw new EmailProviderError(
        `Resend request failed (${detail})`,
        true,
      );
    }

    if (!response.ok) {
      const transient = response.status === 429 || response.status >= 500;
      // NOTE: body intentionally not attached (may echo request data).
      throw new EmailProviderError(
        `Resend API responded with status ${response.status}`,
        transient,
        response.status,
      );
    }

    let payload: { id?: string } = {};
    try {
      payload = (await response.json()) as { id?: string };
    } catch {
      // A bodyless 2xx still counts as accepted; keep an opaque id.
    }

    return { id: payload.id ?? 'resend-accepted' };
  }
}
