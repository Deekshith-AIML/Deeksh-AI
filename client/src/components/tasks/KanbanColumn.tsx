/**
 * src/components/tasks/KanbanColumn.tsx
 * ------------------------------------
 * Column wrapper for a single Kanban status lane.
 * Renders the column header (title + count + accent dot) and the
 * vertical stack of TaskCards. Shows an empty state when no tasks match.
 */

'use client';

import { cn } from '@/lib/utils';
import TaskCard from './TaskCard';
import type { Task, TaskStatus } from '@/types';

interface KanbanColumnProps {
  title: string;
  status: TaskStatus;
  tasks: Task[];
  /** Tailwind background class for the header accent dot, e.g. `bg-blue-500`. */
  accentColor: string;
}

export function KanbanColumn({ title, tasks, accentColor }: KanbanColumnProps) {
  return (
    <section className="flex min-h-[320px] flex-col rounded-xl border border-slate-200 bg-slate-50/80">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={cn('h-2.5 w-2.5 rounded-full', accentColor)}
            aria-hidden="true"
          />
          <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        </div>
        <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium tabular-nums text-slate-600">
          {tasks.length}
        </span>
      </header>

      {/* Task list */}
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {tasks.length === 0 ? (
          <p className="py-10 text-center text-xs text-slate-400">
            No tasks here
          </p>
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} />)
        )}
      </div>
    </section>
  );
}

export default KanbanColumn;
