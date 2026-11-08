import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setClock,
  resetClock,
  tomorrow,
  dayAfterTomorrow,
  nextMonday,
  isStaleDate,
  DEFAULT_TIMEZONE,
} from '../src/services/date.service.js';

function frozen(dateStr: string) {
  return {
    now: () => new Date(dateStr),
    nowString: () => new Date(dateStr).toISOString(),
  };
}

describe('M1 - Dynamic date context', () => {
  beforeEach(() => {
    setClock(frozen('2026-10-23T09:30:00+05:30'));
  });
  afterEach(() => {
    resetClock();
  });

  it('October 23, 2026 + tomorrow resolves to October 24, 2026', () => {
    const d = tomorrow();
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(9); // October (0-based)
    expect(d.getDate()).toBe(24);
  });

  it('October 23, 2026 + day after tomorrow resolves to October 25, 2026', () => {
    const d = dayAfterTomorrow();
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(9);
    expect(d.getDate()).toBe(25);
  });

  it('next Monday from October 23, 2026 (Friday) is October 26, 2026', () => {
    const d = nextMonday();
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(9);
    expect(d.getDate()).toBe(26);
  });

  it('stale May 2025 date is rejected safely', () => {
    expect(isStaleDate('2025-05-01T09:00:00+05:30')).toBe(true);
  });

  it('current-year date is not stale', () => {
    expect(isStaleDate('2026-10-24T09:00:00+05:30')).toBe(false);
  });
});

describe('M1 - Default timezone', () => {
  it('defaults to Asia/Kolkata', () => {
    expect(DEFAULT_TIMEZONE).toBe('Asia/Kolkata');
  });
});