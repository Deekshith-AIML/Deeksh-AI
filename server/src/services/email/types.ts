/**
 * services/email/types.ts
 * -----------------------
 * Provider-neutral email contract (Milestone 2).
 *
 * The scheduler depends ONLY on this interface, so the concrete provider
 * (Resend in production, a mock in tests) can be swapped without touching
 * delivery/retry logic. Credentials never cross this boundary — the
 * concrete provider reads them from the environment itself.
 */

/** A single outbound message. */
export interface EmailMessage {
  /** Recipient address — always derived from authenticated user data. */
  to: string;
  subject: string;
  /** Plain-text fallback body. */
  text: string;
  /** HTML body. */
  html: string;
}

/** Provider-confirmed send result. */
export interface EmailSendResult {
  /** Provider message id (used for delivery correlation in logs). */
  id: string;
}

/**
 * Provider failure with an explicit retry classification.
 * - `transient = true`  → worth retrying (network/timeout/429/5xx)
 * - `transient = false` → permanent (bad credentials, invalid address…);
 *   retrying cannot succeed, so the reminder fails fast.
 */
export class EmailProviderError extends Error {
  constructor(
    message: string,
    public readonly transient: boolean,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'EmailProviderError';
  }
}

/** Email provider abstraction. */
export interface EmailProvider {
  /** Short identifier for logs (e.g. "resend", "mock"). */
  readonly name: string;
  /**
   * Send one message. MUST reject with `EmailProviderError` on failure so
   * the scheduler can classify retries. Never log credentials inside.
   */
  send(message: EmailMessage): Promise<EmailSendResult>;
}
