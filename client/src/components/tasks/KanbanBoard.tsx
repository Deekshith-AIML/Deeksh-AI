/**
 * src/components/tasks/KanbanBoard.tsx
 * -----------------------------------
 * Three-column Kanban board (To Do → In Progress → Done).
 * - Fetches tasks from the backend on mount.
 * - Subscribes to the task store so it re-renders automatically when the
 *   AI chat flow refreshes tasks after a `create_task` tool call.
 * - Responsive: 1 column on mobile, 3 columns on md+ screens.
 */

'use client';

import { useEffect } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useTaskStore } from '@/store/useTaskStore';
import KanbanColumn from './KanbanColumn';
import type { Task, TaskStatus } from '@/types';

// ---------------------------------------------------------------------------
// Column configuration
// ---------------------------------------------------------------------------

interface ColumnConfig {
  status: TaskStatus;
  title: string;
  accentColor: string;
}

const COLUMNS: ColumnConfig[] = [
  { status: 'todo', title: 'To Do', accentColor: 'bg-slate-400' },
  { status: 'in_progress', title: 'In Progress', accentColor: 'bg-blue-500' },
  { status: 'done', title: 'Done', accentColor: 'bg-emerald-500' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function KanbanBoard() {
  // Individual selectors keep re-renders granular.
  const tasks = useTaskStore((state) => state.tasks);
  const isLoading = useTaskStore((state) => state.isLoading);
  const error = useTaskStore((state) => state.error);
  const fetchTasks = useTaskStore((state) => state.fetchTasks);

  // Load tasks on first mount.
  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  // Group tasks by status into the three lanes.
  const grouped: Record<TaskStatus, Task[]> = {
    todo: tasks.filter((t) => t.status === 'todo'),
    in_progress: tasks.filter((t) => t.status === 'in_progress'),
    done: tasks.filter((t) => t.status === 'done'),
  };

  // Initial full-page loading state.
  if (isLoading && tasks.length === 0) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center gap-2 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading tasks…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Error banner */}
      {error && (
        <div
          role="alert"
          className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
          <button
            type="button"
            onClick={() => useTaskStore.getState().clearError()}
            className="ml-auto font-medium underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Columns */}
      <div className="grid flex-1 grid-cols-1 gap-4 md:grid-cols-3">
        {COLUMNS.map((column) => (
          <KanbanColumn
            key={column.status}
            title={column.title}
            status={column.status}
            tasks={grouped[column.status]}
            accentColor={column.accentColor}
          />
        ))}
      </div>
    </div>
  );
}

export default KanbanBoard;
