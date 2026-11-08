/**
 * services/credential.guard.ts
 * ----------------------------
 * Content classification shared by memory STORAGE (createMemory) and
 * STRUCTURED EXTRACTION (extraction.service) — Milestone 4.1 Task C.
 *
 * Two layers, both conservative:
 * - `looksLikeCredential(text)` → content must NEVER be stored as a
 *   memory (passwords, API keys, tokens, card numbers, private keys…).
 *   Used as an auto-guard inside `createMemory` so even a caller that
 *   forgets `sensitivity: 'credential'` cannot persist a secret.
 * - `looksSensitive(text)` → content stored as `sensitivity: 'sensitive'`
 *   (medical, financial, contact details). Sensitive memories are already
 *   excluded from chat context by default (`include_sensitive_in_chat`).
 *
 * Heuristics only — they fail CLOSED for credentials (over-blocking a
 * secret is acceptable; storing one is not) and fail OPEN for sensitivity
 * (the user can still review stored rows in the Memory Dashboard).
 */

/**
 * Credential patterns. Keep these tight enough that ordinary chat
 * ("I use tokens in my NLP project") is not blocked, but any real secret
 * shape is caught. `password`/`passcode` are blocked anywhere in text —
 * there is no legitimate reason to store one in a memory.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bpass(word|code|phrase|wd)\b/i,
  /\bapi[ _-]?key\b/i,
  /\bsk-[A-Za-z0-9_-]{8,}/, // OpenAI-style secret keys
  /\bAIza[0-9A-Za-z_-]{8,}/, // Google API keys
  /\bgh[pousr]_[A-Za-z0-9]{8,}/, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/, // Slack tokens
  /\b(bearer|access|auth|refresh|session|id)[ _-]?token\b/i,
  /\bprivate key\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bcredit card\b|\bcard number\b|\bcvv\b|\bcvv2\b/i,
  /\b(ssn|social security)\b/i,
  /\b(secret|secrets)\s*(is|[:=])\b/i,
];

/** True when text appears to contain a credential that must never be stored. */
export function looksLikeCredential(text: string): boolean {
  const value = String(text ?? '');
  return CREDENTIAL_PATTERNS.some((re) => re.test(value));
}

/** Patterns that make stored content sensitive (hidden from chat by default). */
const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(medic(al|ine)?|doctor|diagnos(is|es|ed)|therap(y|ist)|prescription|pill(s)?|anxiety|depress(ed|ion)?)\b/i,
  /\b(salary|paycheck|compensation|loan|debt|mortgage|bank account|routing number)\b/i,
  /\b(home address|street address|apartment)\b/i,
  /\b(phone number|mobile number|whatsapp number)\b/i,
  /\b(date of birth|birthday is)\b/i,
];

/** True when text should be stored with sensitivity = 'sensitive'. */
export function looksSensitive(text: string): boolean {
  const value = String(text ?? '');
  return SENSITIVE_PATTERNS.some((re) => re.test(value));
}
