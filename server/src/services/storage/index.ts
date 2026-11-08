/**
 * services/storage/index.ts
 * -------------------------
 * Storage provider factory.
 *
 * The provider is selected per call from `STORAGE_PROVIDER` so tests can
 * switch adapters without module reloads:
 *
 *   supabase (default) -> private bucket, user-scoped or admin client
 *   local              -> development-only filesystem adapter
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getDocumentsConfig } from '../../config/documents.config.js';
import { LocalStorageProvider } from './local.storage.js';
import { SupabaseStorageProvider } from './supabase.storage.js';
import type { StorageProvider } from './storage.provider.js';

export type { StorageProvider } from './storage.provider.js';
export { StorageError } from './storage.provider.js';

/**
 * Build the configured provider for the given Supabase client.
 *
 * In `local` mode the client is ignored, which is what lets the worker and
 * tests run without any Supabase credentials at all.
 */
export function createStorageProvider(client?: SupabaseClient): StorageProvider {
  const config = getDocumentsConfig();
  if (config.storageProvider === 'local') {
    return new LocalStorageProvider(config.localStorageDir);
  }
  if (!client) {
    throw new Error('Supabase storage provider requires a Supabase client');
  }
  return new SupabaseStorageProvider(client, config.bucket);
}
