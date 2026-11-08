/**
 * services/storage/supabase.storage.ts
 * ------------------------------------
 * Private Supabase Storage adapter.
 *
 * The client passed in determines the authority:
 * - API requests pass the USER-SCOPED client, so storage RLS
 *   (`(storage.foldername(name))[1] = auth.uid()` from 0012) applies.
 * - The background worker passes the service-role client, which can read
 *   across users by design.
 *
 * No public URL is ever produced: reads go through `createSignedUrl` with a
 * short TTL.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type StorageProvider,
  StorageError,
  assertSafeObjectPath,
} from './storage.provider.js';

interface StorageApiResponse<T> {
  data: T;
  error: { message: string } | null;
}

export class SupabaseStorageProvider implements StorageProvider {
  readonly kind = 'supabase' as const;

  constructor(
    private readonly client: SupabaseClient,
    private readonly bucket: string,
  ) {}

  private bucketApi() {
    // `storage` is present on the Supabase client but missing from the
    // structural type used in some test doubles.
    return (this.client as unknown as {
      storage: { from(bucket: string): {
        upload(path: string, body: Buffer, opts?: Record<string, unknown>): Promise<StorageApiResponse<unknown>>;
        download(path: string): Promise<StorageApiResponse<Blob>>;
        remove(paths: string[]): Promise<StorageApiResponse<unknown>>;
        createSignedUrl(path: string, expiresIn: number): Promise<StorageApiResponse<{ signedUrl: string }>>;
      } };
    }).storage.from(this.bucket);
  }

  async put(path: string, bytes: Buffer, contentType: string): Promise<void> {
    assertSafeObjectPath(path);
    const { error } = await this.bucketApi().upload(path, bytes, {
      contentType,
      upsert: false,
    });
    if (error) {
      throw new StorageError(`Storage upload failed: ${error.message}`, 'STORAGE_UPLOAD_FAILED');
    }
  }

  async get(path: string): Promise<Buffer> {
    assertSafeObjectPath(path);
    const { data, error } = await this.bucketApi().download(path);
    if (error || !data) {
      throw new StorageError('Stored document object could not be read.', 'STORAGE_OBJECT_MISSING');
    }
    return Buffer.from(await data.arrayBuffer());
  }

  async remove(path: string): Promise<void> {
    assertSafeObjectPath(path);
    const { error } = await this.bucketApi().remove([path]);
    if (error) {
      throw new StorageError(`Storage delete failed: ${error.message}`, 'STORAGE_DELETE_FAILED');
    }
  }

  async signedUrl(path: string, expiresInSeconds: number): Promise<string | null> {
    assertSafeObjectPath(path);
    const ttl = Math.max(30, Math.min(Math.floor(expiresInSeconds), 900));
    const { data, error } = await this.bucketApi().createSignedUrl(path, ttl);
    if (error || !data?.signedUrl) {
      throw new StorageError('Could not create a document link.', 'STORAGE_SIGN_FAILED');
    }
    return data.signedUrl;
  }
}
