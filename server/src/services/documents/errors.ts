/**
 * services/documents/errors.ts
 * ----------------------------
 * Typed errors for the Knowledge Base.
 *
 * `code` is a stable machine-readable string (safe to log and to return),
 * `statusCode` maps to HTTP. Messages are authored for humans and never
 * contain document content, storage paths or stack traces.
 */

export class DocumentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DocumentError';
  }
}

export function isDocumentError(err: unknown): err is DocumentError {
  return err instanceof DocumentError;
}

/** Validation failures (bad file) are 400-class. */
export class DocumentValidationError extends DocumentError {
  constructor(message: string, code: string, statusCode = 400, details?: unknown) {
    super(message, code, statusCode, details);
    this.name = 'DocumentValidationError';
  }
}
