/**
 * src/components/ui/Badge.tsx
 * ---------------------------
 * Reusable pill badge for task priority and status.
 * Color-coded variants:
 *   - high → red, medium → amber, low → green
 *   - todo → slate, in_progress → blue, done → emerald
 */

'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { TaskPriority, TaskStatus } from '@/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type BadgeVariant = TaskPriority | TaskStatus | 'default';

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}

// ---------------------------------------------------------------------------
// Style map
// ---------------------------------------------------------------------------

const variantClasses: Record<BadgeVariant, string> = {
  // Priority variants
  high: 'bg-red-100 text-red-700 ring-1 ring-red-200',
  medium: 'bg-amber-100 text-amber-800 ring-1 ring-amber-200',
  low: 'bg-green-100 text-green-700 ring-1 ring-green-200',
  // Status variants
  todo: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200',
  in_progress: 'bg-blue-100 text-blue-700 ring-1 ring-blue-200',
  done: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  // Fallback
  default: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Badge({ variant = 'default', children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize whitespace-nowrap',
        variantClasses[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}

export default Badge;
export type { BadgeProps, BadgeVariant };
