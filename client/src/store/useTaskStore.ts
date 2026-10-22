/**
 * src/store/useTaskStore.ts
 * -------------------------
 * Zustand store managing task state and all CRUD calls to the backend.
 *
 * Endpoints used (all via the shared Axios instance, which attaches the
 * `Authorization: Bearer <access_token>` header automatically):
 *   - GET    /tasks        → fetchTasks
 *   - POST   /tasks        → createTask
 *   - PUT    /tasks/:id    → updateTask / updateTaskStatus
 *   - DELETE /tasks/:id    → deleteTask
 */

'use client';

import { create } from 'zustand';
import api from '@/lib/api';
import type {
  Task,
  TaskStatus,
  CreateTaskInput,
  UpdateTaskInput,
  ListTasksResponse,
  TaskResponse,
} from '@/types';

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface TaskState {
  /** All tasks belonging to the current user. */
  tasks: Task[];
  /** True while an initial fetch or mutation is in flight. */
  isLoading: boolean;
  /** Last error message, if any. Cleared on the next successful action. */
  error: string | null;

  /** Fetch all tasks from the backend and replace local state. */
  fetchTasks: () => Promise<void>;
  /** Create a task via POST /tasks and prepend it to the local list. */
  createTask: (input: CreateTaskInput) => Promise<Task | null>;
  /** Update arbitrary fields on a task via PUT /tasks/:id. */
  updateTask: (id: string, input: UpdateTaskInput) => Promise<Task | null>;
  /** Convenience wrapper that only changes a task's status. */
  updateTaskStatus: (id: string, status: TaskStatus) => Promise<void>;
  /** Delete a task via DELETE /tasks/:id and remove it locally. */
  deleteTask: (id: string) => Promise<boolean>;
  /** Reset the error banner. */
  clearError: () => void;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  isLoading: false,
  error: null,

  fetchTasks: async () => {
    set({ isLoading: true, error: null });
    try {
      const { data } = await api.get<ListTasksResponse>('/tasks');
      set({ tasks: data.tasks, isLoading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load tasks',
        isLoading: false,
      });
    }
  },

  createTask: async (input: CreateTaskInput) => {
    set({ error: null });
    try {
      const { data } = await api.post<TaskResponse>('/tasks', input);
      // Prepend so the newest task appears first in the column list.
      set((state) => ({ tasks: [data.task, ...state.tasks] }));
      return data.task;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to create task' });
      return null;
    }
  },

  updateTask: async (id: string, input: UpdateTaskInput) => {
    set({ error: null });
    try {
      const { data } = await api.put<TaskResponse>(`/tasks/${id}`, input);
      // Replace the updated task in place.
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === id ? data.task : t)),
      }));
      return data.task;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to update task' });
      return null;
    }
  },

  updateTaskStatus: async (id: string, status: TaskStatus) => {
    await get().updateTask(id, { status });
  },

  deleteTask: async (id: string) => {
    set({ error: null });
    try {
      await api.delete(`/tasks/${id}`);
      set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) }));
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete task' });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));
