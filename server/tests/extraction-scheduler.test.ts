import { describe, it, expect, vi, afterEach } from 'vitest';
import { startExtractionScheduler } from '../src/workers/extraction.scheduler.js';

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('extraction scheduler', () => {
  it('recovers stale claims before processing jobs and reports stats', async () => {
    const calls: string[] = [];
    const scheduler = startExtractionScheduler({
      client: {},
      runOnStart: false,
      intervalMs: 60_000,
      logger: silentLogger(),
      recover: async () => {
        calls.push('recover');
        return 2;
      },
      processJobs: async () => {
        calls.push('process');
        return { processed: 3, failed: 1 };
      },
    });

    const stats = await scheduler.tick();
    await scheduler.stop();

    expect(calls).toEqual(['recover', 'process']);
    expect(stats).toEqual({ recovered: 2, processed: 3, failed: 1 });
  });

  it('is single-flight: concurrent ticks share one run', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processJobs = vi.fn(async () => {
      await gate;
      return { processed: 1, failed: 0 };
    });

    const scheduler = startExtractionScheduler({
      client: {},
      runOnStart: false,
      intervalMs: 60_000,
      logger: silentLogger(),
      recover: async () => 0,
      processJobs,
    });

    const first = scheduler.tick();
    const second = scheduler.tick();
    expect(second).toBe(first);

    release!();
    const stats = await first;
    await scheduler.stop();

    expect(processJobs).toHaveBeenCalledTimes(1);
    expect(stats.processed).toBe(1);
  });

  it('logs processing errors instead of throwing, and keeps ticking', async () => {
    const logger = silentLogger();
    const scheduler = startExtractionScheduler({
      client: {},
      runOnStart: false,
      intervalMs: 60_000,
      logger,
      recover: async () => 0,
      processJobs: async () => {
        throw new Error('database went away');
      },
    });

    await expect(scheduler.tick()).resolves.toEqual({
      recovered: 0,
      processed: 0,
      failed: 0,
    });
    expect(logger.error).toHaveBeenCalledWith(
      'job processing failed:',
      'database went away',
    );
    await scheduler.stop();
  });

  it('stops polling after stop() and waits for an in-flight tick', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processJobs = vi.fn(async () => {
      await gate;
      return { processed: 1, failed: 0 };
    });

    const scheduler = startExtractionScheduler({
      client: {},
      runOnStart: false,
      intervalMs: 1_000,
      logger: silentLogger(),
      recover: async () => 0,
      processJobs,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(processJobs).toHaveBeenCalledTimes(1);

    const stopping = scheduler.stop();
    release!();
    await stopping;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(processJobs).toHaveBeenCalledTimes(1);
  });
});
