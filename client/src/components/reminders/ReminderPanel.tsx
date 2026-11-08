/**
 * src/components/reminders/ReminderPanel.tsx
 * -----------------------------------------
 * Reminder management panel (Milestone 2) — rendered above the Kanban
 * board in the right pane.
 *
 * VISUAL DISTINCTION (important): reminders use a violet Bell theme with
 * their own status pills, deliberately different from task due dates
 * (slate Clock line on each task card). A reminder is a scheduled EMAIL
 * notification; a due date is a deadline — the UI never merges them.
 *
 * States covered:
 * - loading      → spinner while the list fetches
 * - empty        → friendly "no reminders yet" message
 * - error        → alert banner with Dismiss (fetch/create/reschedule/cancel)
 * - success      → transient confirmation after create/reschedule/cancel
 * - delivery     → per-reminder status pill; FAILED rows show the real
 *                  failure_reason (never rendered as delivered)
 *
 * Mutations: create (any time), reschedule + cancel (pending only — the
 * API returns 409 otherwise, and the buttons are hidden for other states).
 */

'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { format } from 'date-fns';
import { Bell, Loader2, AlertCircle, XCircle, CheckCircle2, Pencil } from 'lucide-react';
import { useReminderStore } from '@/store/useReminderStore';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { Reminder, ReminderStatus } from '@/types';

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<ReminderStatus, { label: string; className: string }> = {
  pending: { label: 'Scheduled', className: 'bg-violet-100 text-violet-700 ring-1 ring-violet-200' },
  claimed: { label: 'Sending…', className: 'bg-blue-100 text-blue-700 ring-1 ring-blue-200' },
  sent: { label: 'Delivered', className: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200' },
  failed: { label: 'Failed', className: 'bg-red-100 text-red-700 ring-1 ring-red-200' },
  cancelled: { label: 'Cancelled', className: 'bg-slate-100 text-slate-500 ring-1 ring-slate-200' },
};

function StatusPill({ status }: { status: ReminderStatus }) {
  const style = STATUS_STYLES[status];
  return (
    <span
      data-status={status}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${style.className}`}
    >
      {style.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a `datetime-local` value ("2026-11-05T18:00") into an ISO-8601
 * string with an explicit offset (what the API schema requires).
 */
function localValueToIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

/** Smallest allowed datetime-local value: now (server enforces future). */
function nowLocalValue(): string {
  const d = new Date(Date.now() + 60_000); // 1 minute ahead as a safe floor
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------

function ReminderCreateForm() {
  const createReminder = useReminderStore((s) => s.createReminder);
  const isMutating = useReminderStore((s) => s.isMutating);
  const clearSuccess = useReminderStore((s) => s.clearSuccess);

  const [title, setTitle] = useState('');
  const [when, setWhen] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearSuccess();

    const trimmed = title.trim();
    if (!trimmed) {
      setLocalError('Give the reminder a title.');
      return;
    }
    const iso = localValueToIso(when);
    if (!iso) {
      setLocalError('Pick a date and time.');
      return;
    }
    if (new Date(iso).getTime() <= Date.now()) {
      setLocalError('The reminder time must be in the future.');
      return;
    }
    setLocalError(null);

    const created = await createReminder({ title: trimmed, reminder_at: iso });
    if (created) {
      setTitle('');
      setWhen('');
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 rounded-xl border border-violet-200 bg-violet-50/50 p-3 sm:flex-row sm:items-end"
      aria-label="Schedule a new reminder"
    >
      <label className="flex-1">
        <span className="mb-1 block text-[11px] font-medium text-violet-800">Reminder for</span>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Call the dentist"
          maxLength={500}
          className="h-9 bg-white text-xs"
          aria-label="Reminder title"
        />
      </label>
      <label>
        <span className="mb-1 block text-[11px] font-medium text-violet-800">Email me at</span>
        <Input
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          min={nowLocalValue()}
          className="h-9 bg-white text-xs"
          aria-label="Reminder time"
        />
      </label>
      <Button
        type="submit"
        size="sm"
        isLoading={isMutating}
        className="h-9 shrink-0 bg-violet-700 text-xs text-white hover:bg-violet-800"
      >
        <Bell className="h-3.5 w-3.5" aria-hidden="true" />
        Schedule
      </Button>
      {localError && (
        <p role="alert" className="w-full text-[11px] text-red-600 sm:basis-full">
          {localError}
        </p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Single reminder row
// ---------------------------------------------------------------------------

interface ReminderRowProps {
  reminder: Reminder;
}

function ReminderRow({ reminder }: ReminderRowProps) {
  const cancelReminder = useReminderStore((s) => s.cancelReminder);
  const rescheduleReminder = useReminderStore((s) => s.rescheduleReminder);
  const isMutating = useReminderStore((s) => s.isMutating);

  const [rescheduling, setRescheduling] = useState(false);
  const [newWhen, setNewWhen] = useState('');

  const isPending = reminder.status === 'pending';

  const handleReschedule = async () => {
    const iso = localValueToIso(newWhen);
    if (!iso || new Date(iso).getTime() <= Date.now()) return;
    const updated = await rescheduleReminder(reminder.id, { reminder_at: iso });
    if (updated) {
      setRescheduling(false);
      setNewWhen('');
    }
  };

  return (
    <li
      className="rounded-xl border border-violet-100 bg-white p-3 shadow-sm"
      data-status={reminder.status}
    >
      <div className="flex items-start gap-2">
        <Bell className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-xs font-medium text-slate-900">{reminder.title}</p>
            <StatusPill status={reminder.status} />
          </div>

          {/* Delivery time — violet, distinct from the slate due-date line. */}
          <p className="mt-1 text-[11px] text-violet-700">
            Email · {format(new Date(reminder.reminder_at), 'MMM d, yyyy · h:mm a')}
          </p>

          {/* Honest delivery outcome — only shown when meaningful. */}
          {reminder.status === 'sent' && reminder.sent_at && (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-emerald-600">
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
              Delivered {format(new Date(reminder.sent_at), 'MMM d · h:mm a')}
            </p>
          )}
          {reminder.status === 'failed' && (
            <p className="mt-1 text-[11px] text-red-600">
              Delivery failed
              {reminder.failure_reason ? ` — ${reminder.failure_reason}` : '.'}
            </p>
          )}
          {reminder.status === 'cancelled' && (
            <p className="mt-1 text-[11px] text-slate-400">Cancelled before delivery.</p>
          )}
          {reminder.status === 'pending' && (
            <p className="mt-1 text-[11px] text-slate-400">
              Will be emailed at the time above.
              {reminder.attempts > 0
                ? ` Retry ${reminder.attempts}/${reminder.max_attempts} pending.`
                : ''}
            </p>
          )}
        </div>
      </div>

      {/* Actions — reschedule/cancel only for pending reminders (the API
          rejects other states with 409, and we don't offer doomed buttons). */}
      {isPending && (
        <div className="mt-2 flex items-center justify-end gap-2 border-t border-slate-100 pt-2">
          {rescheduling ? (
            <>
              <Input
                type="datetime-local"
                value={newWhen}
                onChange={(e) => setNewWhen(e.target.value)}
                min={nowLocalValue()}
                className="h-7 w-[170px] px-2 text-[11px]"
                aria-label="New reminder time"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={handleReschedule}
                disabled={isMutating}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => setRescheduling(false)}
              >
                Keep
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => setRescheduling(true)}
                aria-label={`Reschedule reminder "${reminder.title}"`}
              >
                <Pencil className="h-3 w-3" aria-hidden="true" />
                Reschedule
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px] text-red-500 hover:bg-red-50 hover:text-red-600"
                onClick={() => void cancelReminder(reminder.id)}
                disabled={isMutating}
                aria-label={`Cancel reminder "${reminder.title}"`}
              >
                <XCircle className="h-3 w-3" aria-hidden="true" />
                Cancel
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function ReminderPanel() {
  const reminders = useReminderStore((s) => s.reminders);
  const isLoading = useReminderStore((s) => s.isLoading);
  const error = useReminderStore((s) => s.error);
  const successMessage = useReminderStore((s) => s.successMessage);
  const fetchReminders = useReminderStore((s) => s.fetchReminders);
  const clearError = useReminderStore((s) => s.clearError);
  const clearSuccess = useReminderStore((s) => s.clearSuccess);

  // Load reminders on first mount (same pattern as the Kanban board).
  useEffect(() => {
    void fetchReminders();
  }, [fetchReminders]);

  // Split: upcoming (pending/claimed, future first) vs history.
  const upcoming = reminders
    .filter((r) => r.status === 'pending' || r.status === 'claimed')
    .sort((a, b) => (a.reminder_at < b.reminder_at ? -1 : 1));
  const history = reminders
    .filter((r) => r.status !== 'pending' && r.status !== 'claimed')
    .sort((a, b) => (a.reminder_at > b.reminder_at ? -1 : 1));

  return (
    <section
      aria-label="Reminders"
      className="mb-4 rounded-xl border border-violet-200 bg-white p-4"
    >
      {/* Header */}
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-100">
          <Bell className="h-4 w-4 text-violet-700" aria-hidden="true" />
        </div>
        <h3 className="text-xs font-semibold text-slate-900">Email Reminders</h3>
        <span className="text-[10px] font-medium text-violet-600">
          scheduled notifications — not due dates
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div
          role="alert"
          className="mb-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => {
              clearError();
              void fetchReminders();
            }}
            className="font-medium underline hover:no-underline"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={clearError}
            className="font-medium underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Success confirmation */}
      {successMessage && (
        <div
          role="status"
          className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{successMessage}</span>
          <button
            type="button"
            onClick={clearSuccess}
            className="font-medium underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Create form */}
      <ReminderCreateForm />

      {/* List states */}
      {isLoading && reminders.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading reminders…
        </div>
      ) : reminders.length === 0 ? (
        <p className="py-6 text-center text-xs text-slate-400">
          No reminders yet — schedule one above, or ask TaskMate in chat
          (&quot;remind me tomorrow at 9 AM&quot;).
        </p>
      ) : (
        <div className="space-y-4">
          {upcoming.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-violet-700">
                Upcoming
              </h4>
              <ul className="space-y-2">
                {upcoming.map((r) => (
                  <ReminderRow key={r.id} reminder={r} />
                ))}
              </ul>
            </div>
          )}
          {history.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Delivery history
              </h4>
              <ul className="space-y-2">
                {history.map((r) => (
                  <ReminderRow key={r.id} reminder={r} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default ReminderPanel;
