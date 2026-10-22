/**
 * src/components/tasks/TaskCard.tsx
 * ---------------------------------
 * Individual task card rendered inside a Kanban column.
 * Shows:
 * - Task title
 * - Priority badge (red=high, amber=medium, green=low)
 * - Due date with a Clock icon (when set)
 * - A "Move" button that advances the task to its next status
 *   (todo → in_progress → done). No drag-and-drop in v1.
 */

'use client';

import { format } from 'date-fns';
import { Clock, ArrowRight, Trash2 } from 'lucide-react';
import { useTaskStore } from '@/store/useTaskStore';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import type { Task, TaskStatus } from '@/types';

// ---------------------------------------------------------------------------
// Status flow configuration
// ---------------------------------------------------------------------------

/** The next status in the lifecycle, or null when the task is done. */
const NEXT_STATUS: Record<TaskStatus, TaskStatus | null> = {
  todo: 'in_progress',
  in_progress: 'done',
  done: null,
};

/** Button label for advancing out of each status. */
const NEXT_LABEL: Record<TaskStatus, string> = {
  todo: 'Start',
  in_progress: 'Complete',
  done: '',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TaskCardProps {
  task: Task;
}

export function TaskCard({ task }: TaskCardProps) {
  const updateTaskStatus = useTaskStore((state) => state.updateTaskStatus);
  const deleteTask = useTaskStore((state) => state.deleteTask);

  const nextStatus = NEXT_STATUS[task.status];

  const handleMove = async () => {
    if (!nextStatus) return;
    await updateTaskStatus(task.id, nextStatus);
  };

  const handleDelete = async () => {
    await deleteTask(task.id);
  };

  return (
    <article className="group rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-shadow duration-150 hover:shadow-md animate-slide-up">
      {/* Title + priority badge */}
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium leading-snug text-slate-900">
          {task.title}
        </h4>
        <Badge variant={task.priority}>{task.priority}</Badge>
      </div>

      {/* Due date */}
      {task.due_date && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            {format(new Date(task.due_date), 'MMM d, yyyy · h:mm a')}
          </span>
        </div>
      )}

      {/* Actions */}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
        {nextStatus ? (
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 justify-center text-xs font-medium text-slate-600 hover:text-slate-900"
            onClick={handleMove}
            aria-label={`Move task "${task.title}" to ${NEXT_STATUS[task.status]}`}
          >
            {NEXT_LABEL[task.status]}
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Button>
        ) : (
          <span className="flex-1 text-center text-xs font-medium text-emerald-600">
            Completed ✓
          </span>
        )}

        {/* Delete is subtly hidden until hover on desktop. */}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-slate-300 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100"
          onClick={handleDelete}
          aria-label={`Delete task "${task.title}"`}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </article>
  );
}

export default TaskCard;
