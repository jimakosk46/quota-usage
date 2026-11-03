import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { UsageError } from './errors.js';

export interface OwnedProcess {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): void;
  exited?: Promise<unknown>;
}

export class ProcessTracker {
  private readonly owned = new Set<OwnedProcess>();
  private cleaning = false;

  track<T extends OwnedProcess>(process: T): T {
    this.owned.add(process);
    void process.exited?.then(
      () => this.owned.delete(process),
      () => this.owned.delete(process),
    );
    return process;
  }

  untrack(process: OwnedProcess): void {
    this.owned.delete(process);
  }

  get size(): number {
    return this.owned.size;
  }

  async cleanup(graceMs = 500): Promise<void> {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      const processes = [...this.owned];
      for (const process of processes) process.kill('SIGTERM');
      await Promise.all(
        processes.map(async (process) => {
          if (!process.exited) return;
          await Promise.race([
            process.exited.catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, graceMs)),
          ]);
        }),
      );
      for (const process of processes) {
        if (this.owned.has(process)) process.kill('SIGKILL');
      }
      await Promise.all(
        processes.flatMap((process) =>
          process.exited ? [process.exited.catch(() => undefined)] : [],
        ),
      );
      for (const process of processes) this.owned.delete(process);
    } finally {
      this.cleaning = false;
    }
  }

  installSignalHandlers(onSignal?: (signal: NodeJS.Signals) => void): () => void {
    const handler = (signal: NodeJS.Signals): void => {
      onSignal?.(signal);
      void this.cleanup().finally(() => {
        process.exitCode = signal === 'SIGINT' ? 130 : 143;
      });
    };
    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
    return () => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    };
  }
}

/**
 * Calls `onSignal` for the first of `signals` only; later signals are absorbed by the
 * still-installed listeners instead of Node's default exit. Returns a remover.
 */
export function guardSignals(
  signals: readonly NodeJS.Signals[],
  onSignal: (signal: NodeJS.Signals) => void,
): () => void {
  let fired = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (fired) return;
    fired = true;
    onSignal(signal);
  };
  for (const signal of signals) process.on(signal, handler);
  return () => {
    for (const signal of signals) process.off(signal, handler);
  };
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runProcess(
  executable: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    timeoutMs: number;
    tracker: ProcessTracker;
    input?: string;
    maxOutput?: number;
  },
): Promise<RunResult> {
  const child = spawn(executable, args, {
    env: options.env,
    cwd: options.cwd,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  options.tracker.track({
    pid: child.pid,
    kill: (signal) => {
      child.kill(signal);
    },
    exited,
  });
  let stdout = '';
  let stderr = '';
  const max = options.maxOutput ?? 1024 * 1024;
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString()}`.slice(-max);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-max);
  });
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      child.kill('SIGTERM');
      reject(
        new UsageError('timeout', `Process timed out after ${options.timeoutMs}ms`, {
          retryable: true,
        }),
      );
    }, options.timeoutMs);
  });
  try {
    const [code] = (await Promise.race([exited, timeoutPromise])) as [
      number | null,
      NodeJS.Signals | null,
    ];
    return { stdout, stderr, code: code ?? 1 };
  } catch (error) {
    child.kill('SIGKILL');
    await exited.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export function childOwned(child: ChildProcess): OwnedProcess {
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    kill: (signal) => {
      child.kill(signal);
    },
    exited: once(child, 'exit'),
  };
}
