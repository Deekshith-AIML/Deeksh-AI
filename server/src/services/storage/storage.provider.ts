/**
 * services/storage/storage.provider.ts
 * ------------------------------------
 * Storage boundary for document binaries.
 *
 * Everything the API and worker need from object storage goes through this
 * interface, so the product can use private Supabase Storage in production
 * while tests and local verification use a filesystem adapter. Callers never
 * learn which implementation is active except through `kind`.
 *
 * SECURITY CONTRACT:
 * - paths are opaque keys supplied by the server, never by a client;
 * - nothing here is public — `signedUrl` is the only read surface and is
 *   always short-lived;
 * - a missing object is an error, never silently empty bytes.
 */

export class StorageError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export interface StorageProvider {
  readonly kind: 'supabase' | 'local';
  put(path: string, bytes: Buffer, contentType: string): Promise<void>;
  get(path: string): Promise<Buffer>;
  remove(path: string): Promise<void>;
  /** Short-lived signed URL, or null when the provider streams via the API. */
  signedUrl(path: string, expiresInSeconds: number): Promise<string | null>;
}

/**
 * Validate a server-generated object key.
 *
 * Keys are always `{userId}/{documentId}/{filename}`. Rejecting `..`,
 * absolute paths and backslashes here means a bug elsewhere cannot turn a
 * storage key into a filesystem escape in the local adapter.
 */
export function assertSafeObjectPath(path: string): void {
  if (!path || path.length > 512) {
    throw new StorageError('Invalid storage path.', 'INVALID_PATH');
  }
  if (path.includes('..') || path.includes('\\') || path.startsWith('/')) {
    throw new StorageError('Invalid storage path.', 'INVALID_PATH');
  }
  const segments = path.split('/');
  if (segments.length !== 3 || segments.some((s) => s.length === 0)) {
    throw new StorageError('Invalid storage path.', 'INVALID_PATH');
  }
}
