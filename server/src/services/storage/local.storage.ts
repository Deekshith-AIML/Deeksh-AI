/**
 * services/storage/local.storage.ts
 * --------------------------------
 * DEVELOPMENT-ONLY filesystem adapter (`STORAGE_PROVIDER=local`).
 *
 * Why it exists: the local verification harness has no Supabase Storage, and
 * the ingestion pipeline must still be exercisable end-to-end. Production
 * always uses `SupabaseStorageProvider` over a private bucket.
 *
 * Security:
 * - keys are validated (three segments, no `..`, no backslashes) and then
 *   resolved under the root; the resolved path must stay inside the root;
 * - `signedUrl` returns null, so the API streams bytes through an
 *   authenticated route instead of exposing the filesystem;
 * - object names are server-generated UUIDs; user filenames never touch disk.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  type StorageProvider,
  StorageError,
  assertSafeObjectPath,
} from './storage.provider.js';

export class LocalStorageProvider implements StorageProvider {
  readonly kind = 'local' as const;

  constructor(private readonly rootDir: string) {}

  private resolve(pathKey: string): string {
    assertSafeObjectPath(pathKey);
    const root = path.resolve(this.rootDir);
    const absolute = path.resolve(root, pathKey);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw new StorageError('Invalid storage path.', 'INVALID_PATH');
    }
    return absolute;
  }

  async put(pathKey: string, bytes: Buffer, _contentType: string): Promise<void> {
    const absolute = this.resolve(pathKey);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, bytes);
  }

  async get(pathKey: string): Promise<Buffer> {
    const absolute = this.resolve(pathKey);
    try {
      return await fs.readFile(absolute);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new StorageError('Stored document object could not be read.', 'STORAGE_OBJECT_MISSING');
      }
      throw new StorageError('Stored document object could not be read.', 'STORAGE_READ_FAILED');
    }
  }

  async remove(pathKey: string): Promise<void> {
    const absolute = this.resolve(pathKey);
    try {
      await fs.rm(absolute, { force: true });
    } catch {
      throw new StorageError('Stored document object could not be deleted.', 'STORAGE_DELETE_FAILED');
    }
  }

  async signedUrl(_pathKey: string, _expiresInSeconds: number): Promise<string | null> {
    // No public/signed filesystem URLs: the API serves bytes after auth.
    return null;
  }
}
