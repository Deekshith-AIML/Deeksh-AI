/**
 * Phase 6 — Immutable payload binding for approvals (M6).
 *
 * An approval authorizes ONE exact action. This module derives the
 * canonical serialization + SHA-256 hash that binds an approval to:
 *   user_id · run_id · step_id · capability · operation · normalized args
 *
 * At execution time the hash is recomputed from the PERSISTED step state
 * (never from model output or request bodies) and compared byte-for-byte.
 * Any mutation — different task id, different operation, different user —
 * fails the comparison, so a compromised or drifting model cannot ride
 * an old approval into executing a different action.
 */

import { createHash } from 'node:crypto';

/**
 * Deterministic canonical serialization of a JSON-compatible value.
 * Keys are sorted recursively, `-0` is normalized, non-finite numbers and
 * unsupported types are rejected loudly instead of silently hashed.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null'; // treated as absent — consistent on both sides
  const t = typeof value;

  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error('canonicalize: non-finite number cannot be bound');
    }
    const n = value as number === 0 ? 0 : (value as number);
    return JSON.stringify(n);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value as string);

  if (Array.isArray(value)) {
    return `[${(value as unknown[]).map(canonicalize).join(',')}]`;
  }

  if (t === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(
        ([, v]) =>
          v !== undefined &&
          typeof v !== 'function' &&
          typeof v !== 'symbol' &&
          typeof v !== 'bigint',
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${entries.join(',')}}`;
  }

  throw new Error(`canonicalize: unsupported type "${t}" cannot be bound`);
}

/** SHA-256 hex of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Everything an approval is cryptographically bound to. */
export interface ApprovalBinding {
  userId: string;
  runId: string;
  stepId: string;
  capability: string;
  operation: string;
  /** The exact, normalized arguments the action will run with. */
  args: Record<string, unknown>;
}

export function computeApprovalPayloadHash(binding: ApprovalBinding): string {
  const canonical = canonicalize({
    args: binding.args ?? {},
    capability: binding.capability,
    operation: binding.operation,
    run_id: binding.runId,
    step_id: binding.stepId,
    user_id: binding.userId,
  });
  return sha256Hex(canonical);
}
