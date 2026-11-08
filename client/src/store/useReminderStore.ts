/**
 * src/store/useReminderStore.ts
 * -----------------------------
 * Zustand store managing reminder state and all calls to the reminder API
 * (Milestone 2).
 *
 * Endpoints used (all via the shared Axios instance, which attaches the
 * `Authorization: Bearer <access_token>` header automatically):
 *   - GET    /reminders        → fetchReminders
 *   - POST   /reminders        → createReminder (idempotency_key supported)
 *   - PUT    /reminders/:id    → rescheduleReminder (pending only)
 *   - DELETE /reminders/:id    → cancelReminder (pending only — soft delete)
 *
 * The store distinguishes delivery outcomes honestly:
 * - `successMessage`  → transient confirmation after a user action
 * - `error`           → last failed action (create/reschedule/cancel/fetch)
 * - reminder rows carry their own `status` / `failure_reason`, so a FAILED
 *   delivery is never rendered as delivered.
 *
 * SECURITY: no user id is ever sent — identity comes from the bearer token.
 */

'use client';

import { create } from 'zustand';
import api from '@/lib/api';
import type {
  Reminder,
  CreateReminderInput,
  UpdateReminderInput,
  ListRemindersResponse,
  CreateReminderResponse,
  ReminderResponse,
} from '@/types';

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface ReminderState {
  /** All reminders belonging to the current user. */
  reminders: Reminder[];
  /** True while the initial list fetch is in flight. */
  isLoading: boolean;
  /** True while a create/reschedule/cancel mutation is in flight. */
  isMutating: boolean;
  /** Last error message, if any. Cleared on the next successful action. */
  error: string | null;
  /** Transient success confirmation (e.g. "Reminder scheduled"). */
  successMessage: string | null;

  /** Fetch all reminders from the backend and replace local state. */
  fetchReminders: () => Promise<void>;
  /** Create a reminder via POST /reminders and append it locally. */
  createReminder: (input: CreateReminderInput) => Promise<Reminder | null>;
  /** Reschedule a pending reminder via PUT /reminders/:id. */
  rescheduleReminder: (id: string, input: UpdateReminderInput) => Promise<Reminder | null>;
  /** Cancel a pending reminder via DELETE /reminders/:id (soft delete). */
  cancelReminder: (id: string) => Promise<Reminder | null>;
  /** Reset the error banner. */
  clearError: () => void;
  /** Reset the success confirmation. */
  clearSuccess: () => void;
}

/** Extract a readable message from an Axios/unknown error. */
function messageOf(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useReminderStore = create<ReminderState>((set, get) => ({
  reminders: [],
  isLoading: false,
  isMutating: false,
  error: null,
  successMessage: null,

  fetchReminders: async () => {
    set({ isLoading: true, error: null });
    try {
      const { data } = await api.get<ListRemindersResponse>('/reminders');
      set({ reminders: data.reminders, isLoading: false });
    } catch (err) {
      set({
        error: messageOf(err, 'Failed to load reminders'),
        isLoading: false,
      });
    }
  },

  createReminder: async (input: CreateReminderInput) => {
    set({ isMutating: true, error: null, successMessage: null });
    try {
      const { data } = await api.post<CreateReminderResponse>('/reminders', input);
      // Replace an existing row with the same id (idempotent re-post) or append.
      set((state) => ({
        reminders: [
          data.reminder,
          ...state.reminders.filter((r) => r.id !== data.reminder.id),
        ],
        isMutating: false,
        successMessage: data.created
          ? 'Reminder scheduled.'
          : 'Reminder already existed — no duplicate created.',
      }));
      return data.reminder;
    } catch (err) {
      set({
        error: messageOf(err, 'Failed to schedule reminder'),
        isMutating: false,
      });
      return null;
    }
  },

  rescheduleReminder: async (id: string, input: UpdateReminderInput) => {
    set({ isMutating: true, error: null, successMessage: null });
    try {
      const { data } = await api.put<ReminderResponse>(`/reminders/${id}`, input);
      set((state) => ({
        reminders: state.reminders.map((r) => (r.id === id ? data.reminder : r)),
        isMutating: false,
        successMessage: 'Reminder rescheduled.',
      }));
      return data.reminder;
    } catch (err) {
      set({
        error: messageOf(err, 'Failed to reschedule reminder'),
        isMutating: false,
      });
      return null;
    }
  },

  cancelReminder: async (id: string) => {
    set({ isMutating: true, error: null, successMessage: null });
    try {
      const { data } = await api.delete<ReminderResponse>(`/reminders/${id}`);
      set((state) => ({
        reminders: state.reminders.map((r) => (r.id === id ? data.reminder : r)),
        isMutating: false,
        successMessage: 'Reminder cancelled.',
      }));
      return data.reminder;
    } catch (err) {
      set({
        error: messageOf(err, 'Failed to cancel reminder'),
        isMutating: false,
      });
      return null;
    }
  },

  clearError: () => set({ error: null }),
  clearSuccess: () => set({ successMessage: null }),
}));
