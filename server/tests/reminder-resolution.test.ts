/**
 * tests/reminder-resolution.test.ts
 * ---------------------------------
 * Milestone 2: deterministic reminder-time resolution (scenarios
 * 1, 2, 3, 4, 5, 16, 19 of the test plan).
 *
 * Uses a FROZEN clock pinned to Friday, October 23, 2026, 09:30
 * Asia/Kolkata so every expectation is reproducible regardless of the
 * real calendar. The resolver is the backend's single source of truth —
 * the LLM never computes these timestamps itself.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setClock,
  resetClock,
  resolveReminderTime,
  resolveFutureReminderTime,
  formatInIst,
  DEFAULT_TIMEZONE,
  DEFAULT_REMINDER_HOUR,
  IST_OFFSET_MS,
} from '../src/services/date.service.js';

/** Frozen clock: Friday 2026-10-23 09:30 IST (= 04:00 UTC). */
const FROZEN = '2026-10-23T09:30:00+05:30';

function frozenClock(dateStr: string) {
  return {
    now: () => new Date(dateStr),
    nowString: () => new Date(dateStr).toISOString(),
  };
}

describe('reminder time resolution (Milestone 2)', () => {
  beforeEach(() => setClock(frozenClock(FROZEN)));
  afterEach(() => resetClock());

  // --- Scenario 1: explicit reminder date and time ------------------------
  it('preserves an explicit date and time with offset exactly', () => {
    const r = resolveFutureReminderTime('2026-11-05T18:00:00+05:30');
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 18:00 IST = 12:30 UTC — same instant, stored as UTC.
      expect(r.iso).toBe('2026-11-05T12:30:00.000Z');
    }
  });

  it('preserves an explicit Zulu timestamp exactly', () => {
    const r = resolveFutureReminderTime('2026-11-05T18:00:00Z');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.iso).toBe('2026-11-05T18:00:00.000Z');
  });

  // --- Scenario 2: tomorrow at 9 AM --------------------------------------
  it('resolves "tomorrow at 9 AM" to Oct 24, 2026 09:00 IST', () => {
    const r = resolveFutureReminderTime('tomorrow at 9 AM');
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 09:00 IST on Oct 24 = 03:30 UTC.
      expect(r.iso).toBe('2026-10-24T03:30:00.000Z');
    }
  });

  it('resolves plain "tomorrow" with the 9:00 AM default policy', () => {
    const r = resolveFutureReminderTime('tomorrow');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.iso).toBe('2026-10-24T03:30:00.000Z');
  });

  // --- Scenario 3: day after tomorrow ------------------------------------
  it('resolves "day after tomorrow" to Oct 25, 2026', () => {
    const r = resolveFutureReminderTime('day after tomorrow at 7pm');
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 19:00 IST on Oct 25 = 13:30 UTC.
      expect(r.iso).toBe('2026-10-25T13:30:00.000Z');
    }
  });

  // --- Scenario 4: day-only reminder defaults to 9:00 AM ------------------
  it('defaults a date-only reminder to 09:00 Asia/Kolkata', () => {
    expect(DEFAULT_REMINDER_HOUR).toBe(9);
    const r = resolveFutureReminderTime('2026-10-26');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.iso).toBe('2026-10-26T03:30:00.000Z'); // 09:00 IST
  });

  // --- Scenario 5: explicit times are preserved ---------------------------
  it('preserves an explicit clock time on a relative day (18:30 IST)', () => {
    const r = resolveFutureReminderTime('tomorrow at 18:30');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.iso).toBe('2026-10-24T13:00:00.000Z'); // 18:30 IST
  });

  it('preserves a naive date-time as Asia/Kolkata (no silent UTC shift)', () => {
    const r = resolveFutureReminderTime('2026-11-01T18:00');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.iso).toBe('2026-11-01T12:30:00.000Z'); // 18:00 IST
  });

  it('reads bare clock times as 24-hour time (deterministic, no AM/PM guess)', () => {
    const r = resolveFutureReminderTime('tomorrow at 18:00');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.iso).toBe('2026-10-24T12:30:00.000Z'); // 18:00 IST
  });

  // --- Scenario 16: timezone correctness ----------------------------------
  it('resolves durations against the frozen instant (in 2 hours)', () => {
    const r = resolveFutureReminderTime('in 2 hours');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.iso).toBe('2026-10-23T06:00:00.000Z'); // 04:00Z + 2h
  });

  it('resolves "after 30 minutes"', () => {
    const r = resolveReminderTime('after 30 minutes');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.date.toISOString()).toBe('2026-10-23T04:30:00.000Z');
  });

  it('uses Asia/Kolkata as the configured timezone', () => {
    expect(DEFAULT_TIMEZONE).toBe('Asia/Kolkata');
    expect(IST_OFFSET_MS).toBe(5.5 * 60 * 60 * 1000);
  });

  it('renders instants in IST for display (formatInIst)', () => {
    const rendered = formatInIst(new Date('2026-10-24T03:30:00.000Z'));
    // 03:30Z is 09:00 in Asia/Kolkata:
    expect(rendered).toContain('Oct 24, 2026');
    expect(rendered).toContain('09:00 AM');
    expect(rendered).toContain('GMT+5:30');
  });

  it('resolves weekday phrases to the NEXT occurrence (Friday→Monday)', () => {
    // Oct 23, 2026 is a Friday; "next monday at 8 am" → Oct 26 08:00 IST.
    const r = resolveFutureReminderTime('next monday at 8 am');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.iso).toBe('2026-10-26T02:30:00.000Z');
  });

  // --- Scenario 19: invalid / past / unsupported --------------------------
  it('rejects unparseable reminder text', () => {
    const r = resolveFutureReminderTime('sometime soonish');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });

  it('rejects an impossible clock time', () => {
    const r = resolveFutureReminderTime('tomorrow at 99:99');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });

  it('rejects a past time (today at 8 AM when now is 9:30 AM)', () => {
    const r = resolveFutureReminderTime('today at 8 AM');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('past');
      expect(r.message).toMatch(/in the past/i);
    }
  });

  it('rejects an explicit past timestamp', () => {
    const r = resolveFutureReminderTime('2025-05-01T09:00:00+05:30');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('past');
  });

  it('rejects recurrence free-text (must use the explicit recurrence field)', () => {
    const r = resolveFutureReminderTime('every monday at 8 AM');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsupported');
  });

  it('rejects empty input', () => {
    const r = resolveFutureReminderTime('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });

  it('never persists a past time: resolveFutureReminderTime gates on the clock', () => {
    // "today at 9:30 AM" == exactly now → not in the future → rejected.
    const r = resolveFutureReminderTime('today at 9:30 AM');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('past');
  });
});
