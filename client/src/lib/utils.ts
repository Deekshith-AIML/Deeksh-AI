/**
 * src/lib/utils.ts
 * ----------------
 * Small utility helpers shared across the app.
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind CSS classes with conflict resolution.
 * Combines `clsx` (conditional classnames) with `tailwind-merge`
 * (deduplicates conflicting utilities, e.g. `p-2 p-4` → `p-4`).
 *
 * @example cn('px-2', isActive && 'bg-slate-900 text-white', className)
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
