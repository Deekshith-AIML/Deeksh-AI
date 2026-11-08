/**
 * server/src/services/date.service.ts
 * -------------------------------
 * Authoritative date/time resolution for the configured timezone (Asia/Kolkata).
 *
 * Backend is the source of truth for all date calculations.
 * The LLM never invents its own calendar.
 */

/** Timezone used for user-facing dates. */
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/** Controllable clock interface (for deterministic tests). */
export interface Clock {
  now(): Date;
  nowString(): string; // ISO-8601 UTC
}

/** Real system clock. */
export const systemClock: Clock = {
  now: () => new Date(),
  nowString: () => new Date().toISOString(),
};

/** Current active clock (overridden by tests). */
let activeClock: Clock = systemClock;

export function setClock(clock: Clock): void {
  activeClock = clock;
}

export function resetClock(): void {
  activeClock = systemClock;
}

/** Current local time string in configured timezone (fed to system prompt). */
export function getLocalNowString(timezone = DEFAULT_TIMEZONE): string {
  return activeClock.now().toLocaleString('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}

/** Current authoritative UTC timestamp. */
export function getNowUtcString(): string {
  return activeClock.nowString();
}

/** Compute tomorrow from a base date. */
export function tomorrow(baseDate?: Date): Date {
  const d = baseDate ? new Date(baseDate) : activeClock.now();
  d.setDate(d.getDate() + 1);
  return d;
}

/** Compute day after tomorrow from a base date. */
export function dayAfterTomorrow(baseDate?: Date): Date {
  const d = baseDate ? new Date(baseDate) : activeClock.now();
  d.setDate(d.getDate() + 2);
  return d;
}

/** Compute next Monday from a base date. */
export function nextMonday(baseDate?: Date): Date {
  const d = baseDate ? new Date(baseDate) : activeClock.now();
  const daysUntil = (1 + 7 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + daysUntil);
  return d;
}

/** Compute next week (7 days) from a base date. */
export function nextWeek(baseDate?: Date): Date {
  const d = baseDate ? new Date(baseDate) : activeClock.now();
  d.setDate(d.getDate() + 7);
  return d;
}

/** Normalize an AI-provided due_date string to an absolute UTC timestamp string. */
export function normalizeDueDate(input: string): string | null {
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

/** Check whether a date string is stale (more than 1 year in the past). */
export function isStaleDate(dateStr: string, referenceDate?: Date): boolean {
  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) {
    return true;
  }
  const ref = referenceDate ? new Date(referenceDate) : activeClock.now();
  // Reject dates more than 6 months in the past — this catches model
  // training-cutoff hallucinations (e.g. May 2025 when the real date is
  // October/November 2026) while still accepting legitimate past dates.
  const monthsDiff =
    (ref.getFullYear() - parsed.getFullYear()) * 12 +
    (ref.getMonth() - parsed.getMonth());
  return monthsDiff > 6;
}

// ===========================================================================
// Milestone 2 — deterministic reminder-time resolution
// ===========================================================================

/**
 * Fixed UTC offset of Asia/Kolkata (IST observes no DST, so a constant
 * offset is always correct — unlike zones with daylight saving).
 */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Default delivery time for date-only reminders (policy from the spec):
 * "tomorrow" or "2026-10-24" → 09:00 Asia/Kolkata. Explicit times are
 * always preserved and never overridden by this default.
 */
export const DEFAULT_REMINDER_HOUR = 9;

export type ReminderResolution =
  | { ok: true; date: Date }
  | { ok: false; reason: 'invalid' | 'past' | 'unsupported'; message: string };

function reminderFail(
  reason: 'invalid' | 'past' | 'unsupported',
  message: string,
): ReminderResolution {
  return { ok: false, reason, message };
}

/** Calendar date parts of an instant, as seen in Asia/Kolkata. */
function istParts(d: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DEFAULT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const num = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 'NaN');
  return { year: num('year'), month: num('month'), day: num('day') };
}

/**
 * Build the UTC instant of `hours:minutes` on a civil (calendar) date,
 * interpreted in Asia/Kolkata.
 */
function istInstant(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hours, minutes) - IST_OFFSET_MS);
}

/** Shift an IST calendar date by whole days (DST-free, so simple math). */
function addIstDays(
  base: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(base.year, base.month - 1, base.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Weekday (0=Sun..6=Sat) of an IST calendar date. */
function istWeekday(p: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/**
 * Parse a bare clock-time token ("9", "09:30", "18:00", "6pm", "9:30 am").
 * Without a meridiem the value is read as 24-hour time (deterministic —
 * no guessing between 9 AM and 9 PM).
 */
function parseClockTime(token: string): { hours: number; minutes: number } | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(token.trim());
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = m[2] !== undefined ? Number(m[2]) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

/** Friendly IST rendering for user-facing error messages. */
function formatIst(d: Date): string {
  return d.toLocaleString('en-US', {
    timeZone: DEFAULT_TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
}

/**
 * Resolve a reminder timestamp deterministically on the backend.
 *
 * Accepted inputs (Asia/Kolkata unless an explicit offset is given):
 *   - Durations:            "in 2 hours", "after 30 minutes", "in two hours"
 *   - Relative days:        "tomorrow", "tomorrow at 9 AM",
 *                           "today at 18:00", "day after tomorrow at 7pm",
 *                           "next monday at 8 am", "friday at 18:30",
 *                           "next week at 10"
 *   - Date only:            "2026-10-24"        → 09:00 IST (default policy)
 *   - Naive date-time:      "2026-10-24T18:00"  → interpreted as IST
 *   - Explicit offset/Z:    "2026-10-24T18:00:00+05:30" / "...Z" → preserved
 *
 * Rejected (never invented, never silently shifted):
 *   - unparseable text          → { reason: 'invalid' }
 *   - times at or before now    → { reason: 'past' }
 *   - recurrence phrases        → { reason: 'unsupported' } (must be
 *     expressed through the explicit `recurrence` field, not free text)
 */
export function resolveReminderTime(input: string): ReminderResolution {
  const raw = input.trim();
  if (!raw) {
    return reminderFail('invalid', 'The reminder time is empty.');
  }

  // Recurrence must be explicit (handled via the tool's `recurrence`
  // field), never resolved here as a one-time instant.
  if (/\b(every|recurring|weekly)\b/i.test(raw)) {
    return reminderFail(
      'unsupported',
      'Recurring reminder text must be passed via the explicit "recurrence" field, not as a timestamp.',
    );
  }

  const now = activeClock.now();

  // 1) Durations: "in 2 hours" / "after 30 minutes".
  const dur =
    /^(?:in|after)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(minutes?|mins?|hours?|hrs?)$/i.exec(
      raw,
    );
  if (dur) {
    const amountWord = dur[1]!.toLowerCase();
    const amount = /^\d+$/.test(amountWord)
      ? Number(amountWord)
      : NUMBER_WORDS[amountWord];
    if (amount === undefined || amount <= 0) {
      return reminderFail('invalid', `Could not understand the duration "${raw}".`);
    }
    const isHours = /^hour|^hr/i.test(dur[2]!);
    const ms = amount * (isHours ? 60 : 1) * 60_000;
    return { ok: true, date: new Date(now.getTime() + ms) };
  }

  // 2) Relative-day phrases with an optional "at <time>" part.
  const rel =
    /^(today|tomorrow|day after tomorrow|next week)(?:\s+at\s+(.+))?$/i.exec(raw);
  if (rel) {
    const dayWord = rel[1]!.toLowerCase();
    const p = istParts(now);
    let target = p;
    if (dayWord === 'tomorrow') target = addIstDays(p, 1);
    else if (dayWord === 'day after tomorrow') target = addIstDays(p, 2);
    else if (dayWord === 'next week') target = addIstDays(p, 7);

    let hours = DEFAULT_REMINDER_HOUR;
    let minutes = 0;
    if (rel[2]) {
      const t = parseClockTime(rel[2]);
      if (!t) {
        return reminderFail(
          'invalid',
          `Could not understand the time "${rel[2]}" — use e.g. "9 AM", "18:00" or "6:30pm".`,
        );
      }
      hours = t.hours;
      minutes = t.minutes;
    }
    return { ok: true, date: istInstant(target.year, target.month, target.day, hours, minutes) };
  }

  // 3) Weekday phrases: "next monday at 8 am", "friday at 18:30".
  const wd =
    /^(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|thurs|fri|sat)(?:\s+at\s+(.+))?$/i.exec(
      raw,
    );
  if (wd) {
    const targetDow = WEEKDAYS[wd[1]!.toLowerCase()];
    if (targetDow === undefined) {
      return reminderFail('invalid', `Unknown weekday in "${raw}".`);
    }
    const p = istParts(now);
    const todayDow = istWeekday(p);
    // "monday" while it is already Monday → the NEXT occurrence (7 days).
    let daysAhead = (targetDow - todayDow + 7) % 7;
    if (daysAhead === 0) daysAhead = 7;
    const target = addIstDays(p, daysAhead);

    let hours = DEFAULT_REMINDER_HOUR;
    let minutes = 0;
    if (wd[2]) {
      const t = parseClockTime(wd[2]);
      if (!t) {
        return reminderFail(
          'invalid',
          `Could not understand the time "${wd[2]}" — use e.g. "8 AM" or "18:00".`,
        );
      }
      hours = t.hours;
      minutes = t.minutes;
    }
    return { ok: true, date: istInstant(target.year, target.month, target.day, hours, minutes) };
  }

  // 4) Date-only ISO ("2026-10-24") → 09:00 IST (default-time policy).
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const date = istInstant(
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
      DEFAULT_REMINDER_HOUR,
      0,
    );
    if (Number.isNaN(date.getTime())) {
      return reminderFail('invalid', `"${raw}" is not a valid date.`);
    }
    return { ok: true, date };
  }

  // 5) Naive date-time without offset ("2026-10-24T18:00[:ss]") → IST.
  const naive = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (naive && !hasZone) {
    const date = istInstant(
      Number(naive[1]),
      Number(naive[2]),
      Number(naive[3]),
      Number(naive[4]),
      Number(naive[5]),
    );
    if (Number.isNaN(date.getTime())) {
      return reminderFail('invalid', `"${raw}" is not a valid date-time.`);
    }
    return { ok: true, date };
  }

  // 6) Anything else: standard parsing (explicit offsets / Z preserved).
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return reminderFail(
      'invalid',
      `Could not understand the reminder time "${raw}". Use an ISO-8601 timestamp or a phrase like "tomorrow at 9 AM".`,
    );
  }
  return { ok: true, date: parsed };
}

/**
 * Final gate shared by API and AI-tool paths: resolution must succeed
 * AND land in the future. Returns the canonical UTC ISO string on success.
 */
export function resolveFutureReminderTime(
  input: string,
): { ok: true; iso: string } | { ok: false; reason: 'invalid' | 'past' | 'unsupported'; message: string } {
  const resolved = resolveReminderTime(input);
  if (!resolved.ok) return resolved;
  if (resolved.date.getTime() <= activeClock.now().getTime()) {
    return {
      ok: false,
      reason: 'past',
      message: `The reminder time ${formatIst(resolved.date)} is in the past. Please choose a future time.`,
    };
  }
  return { ok: true, iso: resolved.date.toISOString() };
}

/** Render an instant in Asia/Kolkata for display (API/emails/tests). */
export function formatInIst(d: Date): string {
  return d.toLocaleString('en-US', {
    timeZone: DEFAULT_TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
}
