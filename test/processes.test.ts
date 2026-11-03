import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { childOwned, guardSignals, ProcessTracker, runProcess } from '../src/processes.js';

describe('process ownership and cleanup', () => {
  it('terminates tracked children on cleanup but never touches untracked children', async () => {
    const tracker = new ProcessTracker();
    const owned = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    tracker.track(childOwned(owned));
    await tracker.cleanup(20);
    expect(owned.exitCode ?? owned.signalCode).not.toBeNull();
    expect(foreign.exitCode).toBeNull();
    foreign.kill('SIGTERM');
    await once(foreign, 'exit');
  });

  it('kills a timed out subprocess and returns bounded output', async () => {
    const tracker = new ProcessTracker();
    await expect(
      runProcess(
        process.execPath,
        ['-e', "process.stdout.write('x'.repeat(100));setInterval(()=>{},1000)"],
        { timeoutMs: 30, tracker, maxOutput: 10 },
      ),
    ).rejects.toMatchObject({ data: { code: 'timeout' } });
    expect(tracker.size).toBe(0);
  });

  it('supports input, environment, cwd, stderr, nonzero codes, and explicit untracking', async () => {
    const tracker = new ProcessTracker();
    const marker = { kill: () => true };
    tracker.track(marker);
    expect(tracker.size).toBe(1);
    tracker.untrack(marker);
    expect(tracker.size).toBe(0);
    const result = await runProcess(
      process.execPath,
      [
        '-e',
        "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{process.stdout.write(process.env.QUOTA_TEST+s);process.stderr.write(process.cwd());process.exitCode=7})",
      ],
      {
        timeoutMs: 1_000,
        tracker,
        input: 'input',
        env: { ...process.env, QUOTA_TEST: 'env-' },
        cwd: process.cwd(),
      },
    );
    expect(result).toMatchObject({ stdout: 'env-input', code: 7 });
    expect(result.stderr).toContain('quota-usage');
    expect(tracker.size).toBe(0);
  });

  it('escalates objects without exit promises and tolerates rejected exits', async () => {
    const tracker = new ProcessTracker();
    const signals: string[] = [];
    tracker.track({
      kill: (signal) => {
        signals.push(String(signal));
      },
    });
    tracker.track({ kill: () => true, exited: Promise.reject(new Error('already failed')) });
    await tracker.cleanup(1);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(tracker.size).toBe(0);
  });

  it('installs removable SIGINT and SIGTERM cleanup handlers', async () => {
    const tracker = new ProcessTracker();
    const seen: string[] = [];
    const remove = tracker.installSignalHandlers((signal) => seen.push(signal));
    process.emit('SIGINT', 'SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual(['SIGINT']);
    expect(process.exitCode).toBe(130);
    remove();
    process.exitCode = 0;

    const tracker2 = new ProcessTracker();
    const remove2 = tracker2.installSignalHandlers((signal) => seen.push(signal));
    process.emit('SIGTERM', 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(process.exitCode).toBe(143);
    remove2();
    process.exitCode = 0;
  });

  it('guards signals once until removed and restores the listener counts', () => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const baseline = signals.map((signal) => process.listenerCount(signal));
    const seen: string[] = [];
    const remove = guardSignals(signals, (signal) => seen.push(signal));
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(
      baseline.map((count) => count + 1),
    );
    process.emit('SIGHUP', 'SIGHUP');
    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGTERM', 'SIGTERM');
    expect(seen).toEqual(['SIGHUP']);
    // Later signals are absorbed by the still-installed listeners, not by Node's default exit.
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(
      baseline.map((count) => count + 1),
    );
    remove();
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(baseline);
  });

  it('makes concurrent cleanup idempotent and handles signal exits', async () => {
    const tracker = new ProcessTracker();
    let resolveExit: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    tracker.track({ kill: () => undefined, exited });
    const first = tracker.cleanup(20);
    await expect(tracker.cleanup(20)).resolves.toBeUndefined();
    resolveExit?.();
    await first;

    const signaled = await runProcess(
      process.execPath,
      ['-e', "process.kill(process.pid, 'SIGTERM')"],
      { timeoutMs: 1_000, tracker },
    );
    expect(signaled.code).toBe(1);
  });

  it('represents a child without a resolved pid', () => {
    const emitter = new EventEmitter() as ChildProcess;
    emitter.kill = () => true;
    const owned = childOwned(emitter);
    expect(owned).not.toHaveProperty('pid');
    emitter.emit('exit', 0, null);
  });
});
