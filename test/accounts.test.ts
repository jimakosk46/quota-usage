import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ProcessTracker } from '../src/processes.js';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addAccount,
  collectorPaths,
  installClaudeCollector,
  removeAccount,
  restoreClaudeCollector,
} from '../src/accounts.js';
import { ConfigStore, DEFAULT_CONFIG } from '../src/config.js';
import { UsageError } from '../src/errors.js';
import { appPaths } from '../src/paths.js';
import type { AccountConfig, UsageConfig } from '../src/types.js';

async function setup(): Promise<ConfigStore> {
  const home = await mkdtemp(join(tmpdir(), 'accounts-'));
  return new ConfigStore(appPaths(await realpath(home)));
}

async function statusLineCommand(path: string): Promise<unknown> {
  const settings = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  return (settings.statusLine as Record<string, unknown> | undefined)?.command;
}

const PURGE_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const listenerCounts = (): number[] => PURGE_SIGNALS.map((signal) => process.listenerCount(signal));

/** Polls for `path` every 20 ms for at most 5 s; no fixed sleeps. */
async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (
      await lstat(path).then(
        () => true,
        () => false,
      )
    )
      return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Only ESRCH proves the PID is gone (EPERM does not); polls every 20 ms for at most 5 s. */
async function isGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        // Confirmed gone: never signal this PID again, it may be reused.
        const index = vendorPids.indexOf(pid);
        if (index !== -1) vendorPids.splice(index, 1);
        return true;
      }
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A fake vendor that records its PID, signals readiness and then blocks in logout. */
async function pausedVendor(): Promise<{ script: string; ready: string; pidFile: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'vendor-')));
  const ready = join(dir, 'READY');
  const pidFile = join(dir, 'PID');
  return {
    ready,
    pidFile,
    script: `echo $$ > '${pidFile}'\ntouch '${ready}'\nexec sleep 30`,
  };
}

const vendorPids: number[] = [];
async function readVendorPid(pidFile: string): Promise<number> {
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  vendorPids.push(pid);
  return pid;
}

// A SIGHUP during Linux purge leaves a no-op 'error' listener on stdout/stderr for the
// rest of the process; restore the streams so each test starts from the same state.
const terminalStreams = [process.stdout, process.stderr];
let streamListeners: unknown[][] = [];
beforeEach(() => {
  streamListeners = terminalStreams.map((stream) => stream.listeners('error'));
});
afterEach(() => {
  for (const [index, stream] of terminalStreams.entries()) {
    for (const listener of stream.listeners('error')) {
      if (!(streamListeners[index] ?? []).includes(listener)) {
        stream.off('error', listener as (...args: unknown[]) => void);
      }
    }
  }
});

afterEach(() => {
  // A failed assertion must not leave a paused fake vendor running; PIDs already
  // confirmed gone by isGone were removed from the list.
  for (const pid of vendorPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

describe('Claude collector configuration', () => {
  it('previews, installs, records prior settings, and restores safely', async () => {
    const store = await setup();
    const stateDir = join(store.paths.dataDir, 'claude-state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: '/bin/cat' }, theme: 'dark' }),
    );
    const account: AccountConfig = {
      provider: 'claude',
      label: 'work',
      stateDir,
      ownership: 'external',
    };
    let preview = '';
    const installed = await installClaudeCollector(account, store, async (message) => {
      preview = message;
      return true;
    });
    expect(preview).toContain('/bin/cat');
    expect(installed.claudeCollector?.previousStatusLine).toMatchObject({ command: '/bin/cat' });
    expect(await statusLineCommand(join(stateDir, 'settings.json'))).toBe(
      installed.claudeCollector?.wrapperCommand,
    );
    expect((await lstat(collectorPaths(store, 'work').helper)).mode & 0o777).toBe(0o700);
    expect(await restoreClaudeCollector(installed)).toEqual({ restored: true });
    expect(await statusLineCommand(join(stateDir, 'settings.json'))).toBe('/bin/cat');
  });

  it('detects drift and refuses to overwrite newer settings', async () => {
    const store = await setup();
    const stateDir = join(store.paths.dataDir, 'claude-state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'newer' } }),
    );
    const account: AccountConfig = {
      provider: 'claude',
      label: 'work',
      stateDir,
      ownership: 'external',
      claudeCollector: {
        wrapperCommand: 'usage wrapper',
        previousStatusLine: { type: 'command', command: 'old' },
      },
    };
    const result = await restoreClaudeCollector(account);
    expect(result.restored).toBe(false);
    expect(result.drift).toContain('manually');
    expect(await statusLineCommand(join(stateDir, 'settings.json'))).toBe('newer');
  });
});

describe('account registration', () => {
  it('canonicalizes existing Codex state and stores only a hashed identity', async () => {
    const store = await setup();
    const stateDir = join(store.paths.dataDir, 'codex-real');
    const linkedState = join(store.paths.dataDir, 'codex-link');
    await mkdir(stateDir, { recursive: true });
    await symlink(stateDir, linkedState);
    const fake = join(store.paths.dataDir, 'fake-codex');
    await writeFile(
      fake,
      `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('codex-cli 0.150.1');process.exit(0)}
const r=require('node:readline').createInterface({input:process.stdin});
r.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));if(m.method==='account/read')console.log(JSON.stringify({id:m.id,result:{account:{type:'chatgpt',email:'user@example.com',planType:'plus'}}}))});`,
    );
    await chmod(fake, 0o700);
    await store.write(
      {
        ...DEFAULT_CONFIG,
        defaults: { ...DEFAULT_CONFIG.defaults, codexExecutable: fake },
      },
      false,
    );
    const account = await addAccount(store, 'codex', 'personal', {
      stateDir: linkedState,
      confirm: async () => true,
    });
    expect(account.stateDir).toBe(stateDir);
    expect(account.identityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(store.paths.configFile, 'utf8')).not.toContain('user@example.com');
  });

  it('validates Claude through the official CLI and installs its collector', async () => {
    const store = await setup();
    const stateDir = join(store.paths.dataDir, 'claude-state');
    await mkdir(stateDir, { recursive: true });
    const fake = join(store.paths.dataDir, 'fake-claude');
    await writeFile(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo '2.1.238 (Claude Code)'; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn":true}'; exit 0; fi
exit 1
`,
    );
    await chmod(fake, 0o700);
    await store.write(
      {
        ...DEFAULT_CONFIG,
        defaults: { ...DEFAULT_CONFIG.defaults, claudeExecutable: fake },
      },
      false,
    );
    const account = await addAccount(store, 'claude', 'work', {
      stateDir,
      confirm: async () => true,
    });
    expect(account.claudeCollector?.wrapperCommand).toContain('claude-statusline');
    expect(await statusLineCommand(join(stateDir, 'settings.json'))).toBe(
      account.claudeCollector?.wrapperCommand,
    );
  });
});

describe('removal and purge guards', () => {
  it('normal removal leaves external vendor state untouched', async () => {
    const store = await setup();
    const stateDir = join(store.paths.dataDir, 'external');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'keep'), 'credentials belong to vendor');
    const account: AccountConfig = {
      provider: 'codex',
      label: 'personal',
      stateDir,
      ownership: 'external',
    };
    await store.write({ ...DEFAULT_CONFIG, accounts: [account] }, false);
    const result = await removeAccount(store, 'codex:personal', { confirm: async () => true });
    expect(result.messages.join(' ')).toContain('credentials were left untouched');
    expect(await readFile(join(stateDir, 'keep'), 'utf8')).toContain('vendor');
    expect((await store.load()).accounts).toHaveLength(0);
  });

  it('refuses purge for external, symlinked, and mismatched marker targets', async () => {
    const store = await setup();
    const external: AccountConfig = {
      provider: 'codex',
      label: 'x',
      stateDir: join(store.paths.dataDir, 'x'),
      ownership: 'external',
    };
    await mkdir(external.stateDir, { recursive: true });
    await store.write({ ...DEFAULT_CONFIG, accounts: [external] }, false);
    await expect(
      removeAccount(store, 'codex:x', { purge: true, confirm: async () => true }),
    ).rejects.toThrow('Only managed');

    const real = join(store.paths.dataDir, 'real');
    const target = join(store.paths.managedRoot, 'codex', 'x');
    await mkdir(real, { recursive: true });
    await mkdir(join(store.paths.managedRoot, 'codex'), { recursive: true });
    await symlink(real, target);
    const managed: AccountConfig = {
      ...external,
      stateDir: target,
      ownership: 'managed',
      ownershipMarker: 'expected',
    };
    await store.write({ ...DEFAULT_CONFIG, accounts: [managed] });
    await expect(
      removeAccount(store, 'codex:x', { purge: true, confirm: async () => true }),
    ).rejects.toThrow('missing or unsafe');
  });

  it('logs out through the vendor then moves verified managed state to Trash', async () => {
    const store = await setup();
    const stateDir = join(store.paths.managedRoot, 'codex', 'personal');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, '.usage-owner'), JSON.stringify({ id: 'marker' }), {
      mode: 0o600,
    });
    const fake = join(store.paths.dataDir, 'codex');
    await writeFile(fake, '#!/bin/sh\nexit 0\n');
    await chmod(fake, 0o700);
    const account: AccountConfig = {
      provider: 'codex',
      label: 'personal',
      stateDir,
      ownership: 'managed',
      ownershipMarker: 'marker',
    };
    const config: UsageConfig = {
      ...DEFAULT_CONFIG,
      defaults: { ...DEFAULT_CONFIG.defaults, codexExecutable: fake },
      accounts: [account],
    };
    await store.write(config, false);
    const result = await removeAccount(store, 'codex:personal', {
      purge: true,
      confirm: async () => true,
    });
    expect(result.messages.join(' ')).toContain('recoverable from Trash');
    expect(
      await lstat(stateDir).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
});

describe('purge on Linux (freedesktop trash)', () => {
  async function linuxPurgeSetup(
    script: string,
    executable?: string,
  ): Promise<{
    store: ConfigStore;
    stateDir: string;
    called: string;
  }> {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'accounts-linux-')));
    const store = new ConfigStore(appPaths(home, { platform: 'linux', env: {} }));
    const stateDir = join(store.paths.managedRoot, 'codex', 'personal');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, '.usage-owner'), JSON.stringify({ id: 'marker' }), {
      mode: 0o600,
    });
    const called = join(home, 'vendor-called');
    const fake = join(store.paths.dataDir, 'codex');
    await writeFile(fake, executable ?? `#!/bin/sh\ntouch '${called}'\n${script}\n`);
    await chmod(fake, 0o700);
    const account: AccountConfig = {
      provider: 'codex',
      label: 'personal',
      stateDir,
      ownership: 'managed',
      ownershipMarker: 'marker',
    };
    await store.write(
      {
        ...DEFAULT_CONFIG,
        defaults: { ...DEFAULT_CONFIG.defaults, codexExecutable: fake },
        accounts: [account],
      },
      false,
    );
    return { store, stateDir, called };
  }

  const exists = (path: string): Promise<boolean> =>
    lstat(path).then(
      () => true,
      () => false,
    );

  it('linux purge moves state to the freedesktop trash', async () => {
    const { store, stateDir, called } = await linuxPurgeSetup('exit 0');
    const result = await removeAccount(store, 'codex:personal', {
      purge: true,
      confirm: async () => true,
      platform: 'linux',
    });
    expect(await exists(called)).toBe(true);
    expect(result.messages.join(' ')).toContain('recoverable from Trash');
    expect(await exists(stateDir)).toBe(false);
    const files = await readdir(join(store.paths.trashDir, 'files'));
    const infos = await readdir(join(store.paths.trashDir, 'info'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^usage-codex-personal-/);
    expect(infos).toEqual([`${files[0]}.trashinfo`]);
    expect(await exists(join(store.paths.trashDir, 'files', files[0] ?? '', '.usage-owner'))).toBe(
      true,
    );
    expect(result.messages.join(' ')).toContain(
      join(store.paths.trashDir, 'files', files[0] ?? ''),
    );
    expect((await store.load()).accounts).toHaveLength(0);
  });

  it('preflight failure skips logout (linux)', async () => {
    const { store, stateDir, called } = await linuxPurgeSetup('exit 0');
    await mkdir(store.paths.trashDir, { recursive: true });
    await writeFile(join(store.paths.trashDir, 'files'), 'not a directory');
    await expect(
      removeAccount(store, 'codex:personal', {
        purge: true,
        confirm: async () => true,
        platform: 'linux',
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof UsageError &&
        error.message ===
          `Could not prepare Trash ${store.paths.trashDir}: EEXIST; the account was not logged out and its directory was not moved`,
    );
    expect(await exists(called)).toBe(false);
    expect(await exists(stateDir)).toBe(true);
    expect((await store.load()).accounts).toHaveLength(1);
  });

  it('logout failure leaves no trashinfo (linux)', async () => {
    const { store, stateDir, called } = await linuxPurgeSetup('exit 1');
    await expect(
      removeAccount(store, 'codex:personal', {
        purge: true,
        confirm: async () => true,
        platform: 'linux',
      }),
    ).rejects.toThrow('logout failed; state was not moved');
    expect(await exists(called)).toBe(true);
    expect(await readdir(join(store.paths.trashDir, 'info'))).toEqual([]);
    expect(await readdir(join(store.paths.trashDir, 'files'))).toEqual([]);
    expect(await exists(stateDir)).toBe(true);
    expect((await store.load()).accounts).toHaveLength(1);
  });

  it('a vendor spawn failure releases the trash reservation (linux)', async () => {
    // The shebang interpreter is missing, so the spawn itself fails after resolution.
    const { store, stateDir } = await linuxPurgeSetup('', '#!/nonexistent/interpreter\n');
    await expect(
      removeAccount(store, 'codex:personal', {
        purge: true,
        confirm: async () => true,
        platform: 'linux',
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(store.paths.trashDir, 'info'))).toEqual([]);
    expect(await readdir(join(store.paths.trashDir, 'files'))).toEqual([]);
    expect(await exists(join(stateDir, '.usage-owner'))).toBe(true);
    expect((await store.load()).accounts).toHaveLength(1);
  });

  it('an unreadable stale-destination check refuses before logout (linux)', async () => {
    const { store, stateDir, called } = await linuxPurgeSetup('exit 0');
    await expect(
      removeAccount(store, 'codex:personal', {
        purge: true,
        confirm: async () => true,
        platform: 'linux',
        trashFs: {
          lstat: async () => {
            throw Object.assign(new Error('secret detail'), { code: 'EACCES' });
          },
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof UsageError &&
        error.message ===
          `Could not prepare Trash ${store.paths.trashDir}: EACCES; the account was not logged out and its directory was not moved`,
    );
    expect(await exists(called)).toBe(false);
    expect(await readdir(join(store.paths.trashDir, 'info'))).toEqual([]);
    expect(await exists(join(stateDir, '.usage-owner'))).toBe(true);
    expect((await store.load()).accounts).toHaveLength(1);
  });

  it('a logout failure names a reservation it could not release (linux)', async () => {
    const { store, stateDir } = await linuxPurgeSetup('exit 1');
    const error = await removeAccount(store, 'codex:personal', {
      purge: true,
      confirm: async () => true,
      platform: 'linux',
      trashFs: {
        unlink: async () => {
          throw Object.assign(new Error('secret detail'), { code: 'EACCES' });
        },
      },
    }).catch((caught: unknown) => caught);
    const infos = await readdir(join(store.paths.trashDir, 'info'));
    expect(infos).toHaveLength(1);
    const leftover = join(store.paths.trashDir, 'info', infos[0] ?? '');
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).data.code).toBe('provider_failure');
    expect((error as UsageError).message).toBe(
      `codex logout failed; state was not moved; the Trash reservation ${leftover} could not be removed`,
    );
    expect((error as UsageError).data.message).toBe((error as UsageError).message);
    expect(await exists(join(stateDir, '.usage-owner'))).toBe(true);
    expect((await store.load()).accounts).toHaveLength(1);
  });

  it('a spawn failure keeps its code and names an unreleased reservation (linux)', async () => {
    const { store } = await linuxPurgeSetup('', '#!/nonexistent/interpreter\n');
    const error = await removeAccount(store, 'codex:personal', {
      purge: true,
      confirm: async () => true,
      platform: 'linux',
      trashFs: {
        unlink: async () => {
          throw Object.assign(new Error('secret detail'), { code: 'EACCES' });
        },
      },
    }).catch((caught: unknown) => caught);
    const infos = await readdir(join(store.paths.trashDir, 'info'));
    const leftover = join(store.paths.trashDir, 'info', infos[0] ?? '');
    expect(error).toMatchObject({ code: 'ENOENT' });
    expect((error as Error).message).toContain(
      `; the Trash reservation ${leftover} could not be removed`,
    );
  });
});

describe('signals during Linux purge', () => {
  async function signalSetup(
    script: string,
    executable?: string,
  ): Promise<{
    store: ConfigStore;
    stateDir: string;
    called: string;
  }> {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'accounts-signal-')));
    const store = new ConfigStore(appPaths(home, { platform: 'linux', env: {} }));
    const stateDir = join(store.paths.managedRoot, 'codex', 'personal');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, '.usage-owner'), JSON.stringify({ id: 'marker' }), {
      mode: 0o600,
    });
    const called = join(home, 'vendor-called');
    const fake = join(store.paths.dataDir, 'codex');
    await writeFile(fake, executable ?? `#!/bin/sh\ntouch '${called}'\n${script}\n`);
    await chmod(fake, 0o700);
    const account: AccountConfig = {
      provider: 'codex',
      label: 'personal',
      stateDir,
      ownership: 'managed',
      ownershipMarker: 'marker',
    };
    await store.write(
      {
        ...DEFAULT_CONFIG,
        defaults: { ...DEFAULT_CONFIG.defaults, codexExecutable: fake },
        accounts: [account],
      },
      false,
    );
    return { store, stateDir, called };
  }

  const exists = (path: string): Promise<boolean> =>
    lstat(path).then(
      () => true,
      () => false,
    );

  async function expectNothingMoved(store: ConfigStore, stateDir: string): Promise<void> {
    expect(await readdir(join(store.paths.trashDir, 'info'))).toEqual([]);
    expect(await readdir(join(store.paths.trashDir, 'files'))).toEqual([]);
    expect(await exists(join(stateDir, '.usage-owner'))).toBe(true);
    expect((await store.load()).accounts).toHaveLength(1);
  }

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const)(
    '%s during logout stops the vendor and releases the reservation',
    async (signal, exitCode) => {
      const vendor = await pausedVendor();
      const { store, stateDir } = await signalSetup(vendor.script);
      const baseline = listenerCounts();
      const previous = process.exitCode;
      try {
        const removal = removeAccount(store, 'codex:personal', {
          purge: true,
          confirm: async () => true,
          platform: 'linux',
        }).catch((caught: unknown) => caught);
        await waitForFile(vendor.ready);
        const pid = await readVendorPid(vendor.pidFile);
        expect(await readdir(join(store.paths.trashDir, 'info'))).toHaveLength(1);
        process.emit(signal, signal);
        const error = await removal;
        expect(error).toBeInstanceOf(UsageError);
        expect((error as UsageError).data.code).toBe('provider_failure');
        expect((error as UsageError).message).toBe(
          `Interrupted by ${signal}; logout was interrupted and may have completed; the directory was not moved`,
        );
        expect((error as UsageError).data.message).toBe((error as UsageError).message);
        await expectNothingMoved(store, stateDir);
        expect(await isGone(pid)).toBe(true);
        expect(process.exitCode).toBe(exitCode);
        expect(listenerCounts()).toEqual(baseline);
      } finally {
        process.exitCode = previous;
      }
    },
  );

  it('does not commit when the vendor exits 0 on the signal', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'vendor-')));
    const ready = join(dir, 'READY');
    const pidFile = join(dir, 'PID');
    const program = [
      "process.on('SIGINT',()=>process.exit(0));",
      "process.on('SIGTERM',()=>process.exit(0));",
      `require('fs').writeFileSync('${ready}','');`,
      'setInterval(()=>{},1000);',
    ].join('');
    const { store, stateDir } = await signalSetup(
      `echo $$ > '${pidFile}'\nexec '${process.execPath}' -e "${program}"`,
    );
    const baseline = listenerCounts();
    const previous = process.exitCode;
    try {
      const removal = removeAccount(store, 'codex:personal', {
        purge: true,
        confirm: async () => true,
        platform: 'linux',
      }).catch((caught: unknown) => caught);
      await waitForFile(ready);
      const pid = await readVendorPid(pidFile);
      // A terminal Ctrl+C reaches both the vendor and this process.
      process.kill(pid, 'SIGINT');
      process.emit('SIGINT', 'SIGINT');
      const error = await removal;
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toBe(
        'Interrupted by SIGINT; logout was interrupted and may have completed; the directory was not moved',
      );
      await expectNothingMoved(store, stateDir);
      expect(await isGone(pid)).toBe(true);
      expect(process.exitCode).toBe(130);
      expect(listenerCounts()).toEqual(baseline);
    } finally {
      process.exitCode = previous;
    }
  });

  it('a signal before logout skips the vendor and releases the reservation', async () => {
    const { store, stateDir, called } = await signalSetup('exit 0');
    const baseline = listenerCounts();
    const previous = process.exitCode;
    try {
      const error = await removeAccount(store, 'codex:personal', {
        purge: true,
        confirm: async () => true,
        platform: 'linux',
        trashFs: {
          lstat: async (path: string) => {
            // Delivered while the reservation is being prepared.
            process.emit('SIGTERM', 'SIGTERM');
            return lstat(path);
          },
        },
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toBe(
        'Interrupted by SIGTERM; the account was not logged out and its directory was not moved',
      );
      expect(await exists(called)).toBe(false);
      await expectNothingMoved(store, stateDir);
      expect(process.exitCode).toBe(143);
      expect(listenerCounts()).toEqual(baseline);
    } finally {
      process.exitCode = previous;
    }
  });

  it('an interrupted purge names a reservation it could not release', async () => {
    const vendor = await pausedVendor();
    const { store, stateDir } = await signalSetup(vendor.script);
    const baseline = listenerCounts();
    const previous = process.exitCode;
    try {
      const removal = removeAccount(store, 'codex:personal', {
        purge: true,
        confirm: async () => true,
        platform: 'linux',
        trashFs: {
          unlink: async () => {
            throw Object.assign(new Error('secret detail'), { code: 'EACCES' });
          },
        },
      }).catch((caught: unknown) => caught);
      await waitForFile(vendor.ready);
      const pid = await readVendorPid(vendor.pidFile);
      process.emit('SIGINT', 'SIGINT');
      const error = await removal;
      const infos = await readdir(join(store.paths.trashDir, 'info'));
      expect(infos).toHaveLength(1);
      const leftover = join(store.paths.trashDir, 'info', infos[0] ?? '');
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toBe(
        `Interrupted by SIGINT; logout was interrupted and may have completed; the directory was not moved; the Trash reservation ${leftover} could not be removed`,
      );
      expect(await readdir(join(store.paths.trashDir, 'files'))).toEqual([]);
      expect(await exists(join(stateDir, '.usage-owner'))).toBe(true);
      expect((await store.load()).accounts).toHaveLength(1);
      expect(await isGone(pid)).toBe(true);
      expect(listenerCounts()).toEqual(baseline);
    } finally {
      process.exitCode = previous;
    }
  });

  it('success and logout failure leave no signal listeners behind', async () => {
    const baseline = listenerCounts();
    const ok = await signalSetup('exit 0');
    await removeAccount(ok.store, 'codex:personal', {
      purge: true,
      confirm: async () => true,
      platform: 'linux',
    });
    expect(listenerCounts()).toEqual(baseline);
    const failing = await signalSetup('exit 1');
    await expect(
      removeAccount(failing.store, 'codex:personal', {
        purge: true,
        confirm: async () => true,
        platform: 'linux',
      }),
    ).rejects.toThrow('codex logout failed; state was not moved');
    expect(listenerCounts()).toEqual(baseline);
  });

  it.each([
    [
      'prepare failure',
      async (store: ConfigStore) => {
        await mkdir(store.paths.trashDir, { recursive: true });
        await writeFile(join(store.paths.trashDir, 'files'), 'not a directory');
        return {};
      },
      undefined,
      (error: unknown, store: ConfigStore) => {
        expect(error).toBeInstanceOf(UsageError);
        expect((error as UsageError).message).toBe(
          `Could not prepare Trash ${store.paths.trashDir}: EEXIST; the account was not logged out and its directory was not moved`,
        );
      },
    ],
    [
      'spawn error',
      async () => ({}),
      '#!/nonexistent/interpreter\n',
      (error: unknown) => {
        expect(error).toMatchObject({ code: 'ENOENT' });
      },
    ],
    [
      'commit failure',
      async () => ({
        trashFs: {
          rename: async () => {
            throw Object.assign(new Error('secret detail'), { code: 'EACCES' });
          },
        },
      }),
      undefined,
      (error: unknown, store: ConfigStore, stateDir: string) => {
        expect(error).toBeInstanceOf(UsageError);
        const { message } = error as UsageError;
        expect(
          message.startsWith(
            `Could not move ${stateDir} to ${join(store.paths.trashDir, 'files', 'usage-codex-personal-')}`,
          ),
        ).toBe(true);
        expect(message.endsWith('; the directory was not moved')).toBe(true);
      },
    ],
  ] as const)(
    'a Linux %s leaves no signal listeners behind',
    async (_name, arrange, executable, check) => {
      const { store, stateDir } = await signalSetup('exit 0', executable);
      const extra = await arrange(store);
      const baseline = listenerCounts();
      const error = await removeAccount(store, 'codex:personal', {
        purge: true,
        confirm: async () => true,
        platform: 'linux',
        ...extra,
      }).catch((caught: unknown) => caught);
      check(error, store, stateDir);
      expect(listenerCounts()).toEqual(baseline);
      expect(await exists(join(stateDir, '.usage-owner'))).toBe(true);
      expect((await store.load()).accounts).toHaveLength(1);
    },
  );

  it('after SIGHUP, stdout/stderr write errors are harmless', async () => {
    const vendor = await pausedVendor();
    const { store } = await signalSetup(vendor.script);
    const streams = [process.stdout, process.stderr];
    const before = streams.map((stream) => stream.listeners('error'));
    const previous = process.exitCode;
    try {
      const removal = removeAccount(store, 'codex:personal', {
        purge: true,
        confirm: async () => true,
        platform: 'linux',
      }).catch((caught: unknown) => caught);
      await waitForFile(vendor.ready);
      await readVendorPid(vendor.pidFile);
      process.emit('SIGHUP', 'SIGHUP');
      expect(await removal).toBeInstanceOf(UsageError);
      for (const [index, stream] of streams.entries()) {
        // The terminal is gone: a later write fails asynchronously with EIO or EPIPE.
        expect(stream.listenerCount('error')).toBe((before[index] ?? []).length + 1);
        expect(() =>
          stream.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' })),
        ).not.toThrow();
      }
      // A second purge does not stack another listener.
      const again = await signalSetup('exit 0');
      await removeAccount(again.store, 'codex:personal', {
        purge: true,
        confirm: async () => true,
        platform: 'linux',
      });
      expect(streams.map((stream) => stream.listenerCount('error'))).toEqual(
        before.map((listeners) => listeners.length + 1),
      );
    } finally {
      process.exitCode = previous;
    }
  });

  it('a signal during the trash move completes and keeps the move', async () => {
    const { store, stateDir } = await signalSetup('exit 0');
    const baseline = listenerCounts();
    const previous = process.exitCode;
    try {
      const result = await removeAccount(store, 'codex:personal', {
        purge: true,
        confirm: async () => true,
        platform: 'linux',
        trashFs: {
          rename: async (from: PathLike, to: PathLike) => {
            // Delivered while the rename is in flight; the move is not cancelled.
            process.emit('SIGINT', 'SIGINT');
            await rename(from, to);
          },
        },
      });
      expect(result.messages.join(' ')).toContain('recoverable from Trash');
      expect(await exists(stateDir)).toBe(false);
      const files = await readdir(join(store.paths.trashDir, 'files'));
      expect(files).toHaveLength(1);
      expect(
        await exists(join(store.paths.trashDir, 'files', files[0] ?? '', '.usage-owner')),
      ).toBe(true);
      expect(await readdir(join(store.paths.trashDir, 'info'))).toEqual([`${files[0]}.trashinfo`]);
      expect((await store.load()).accounts).toHaveLength(0);
      expect(process.exitCode).toBe(130);
      expect(listenerCounts()).toEqual(baseline);
    } finally {
      process.exitCode = previous;
    }
  });

  const groups: number[] = [];
  afterEach(() => {
    for (const pgid of groups.splice(0)) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        // The group already exited.
      }
    }
  });

  it('a real terminal SIGINT to the process group exits 130 and leaves no reservation', async () => {
    // Library-level coverage of the real signal path: the subprocess repeats the
    // `accounts remove` catch condition because src/cli.ts parses argv on import and its
    // confirmation needs a TTY. The CLI exit-code line itself is covered by review.
    const vendor = await pausedVendor();
    const { store, stateDir } = await signalSetup(vendor.script);
    const dist = (name: string): string => pathToFileURL(join(process.cwd(), 'dist', name)).href;
    const program = [
      `import { removeAccount } from ${JSON.stringify(dist('accounts.js'))};`,
      `import { ConfigStore } from ${JSON.stringify(dist('config.js'))};`,
      `import { appPaths } from ${JSON.stringify(dist('paths.js'))};`,
      `const store = new ConfigStore(appPaths(process.env.TEST_HOME, { platform: 'linux', env: {} }));`,
      "await removeAccount(store, 'codex:personal', { purge: true, confirm: async () => true, platform: 'linux' })",
      '  .catch(() => { if (![129, 130, 143].includes(Number(process.exitCode))) process.exitCode = 2; });',
    ].join('\n');
    // Its own process group, like a terminal job; the vendor inherits the group.
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, TEST_HOME: store.paths.homeDir },
    });
    if (child.pid === undefined) throw new Error('subprocess did not start');
    groups.push(child.pid);
    const exited = once(child, 'exit');
    await waitForFile(vendor.ready);
    const pid = await readVendorPid(vendor.pidFile);
    process.kill(-child.pid, 'SIGINT');
    const [code, signal] = (await exited) as [number | null, NodeJS.Signals | null];
    expect({ code, signal }).toEqual({ code: 130, signal: null });
    expect(await readdir(join(store.paths.trashDir, 'info'))).toEqual([]);
    expect(await readdir(join(store.paths.trashDir, 'files'))).toEqual([]);
    expect(await exists(join(stateDir, '.usage-owner'))).toBe(true);
    expect((await store.load()).accounts).toHaveLength(1);
    expect(await isGone(pid)).toBe(true);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'a SIGHUP after %s still makes terminal write errors harmless',
    async (first, exitCode) => {
      const vendor = await pausedVendor();
      const { store, stateDir } = await signalSetup(vendor.script);
      const baseline = listenerCounts();
      const previous = process.exitCode;
      const tracker = new ProcessTracker();
      const cleanup = tracker.cleanup.bind(tracker);
      let cleanups = 0;
      tracker.cleanup = async (graceMs?: number) => {
        cleanups += 1;
        await cleanup(graceMs);
      };
      try {
        const removal = removeAccount(store, 'codex:personal', {
          purge: true,
          confirm: async () => true,
          platform: 'linux',
          tracker,
        }).catch((caught: unknown) => caught);
        await waitForFile(vendor.ready);
        const pid = await readVendorPid(vendor.pidFile);
        process.emit(first, first);
        // The terminal hangs up while cleanup runs.
        process.emit('SIGHUP', 'SIGHUP');
        const error = await removal;
        expect((error as UsageError).message).toBe(
          `Interrupted by ${first}; logout was interrupted and may have completed; the directory was not moved`,
        );
        expect(() =>
          process.stderr.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' })),
        ).not.toThrow();
        expect(() =>
          process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })),
        ).not.toThrow();
        expect(process.exitCode).toBe(exitCode);
        expect(cleanups).toBe(1);
        await expectNothingMoved(store, stateDir);
        expect(await isGone(pid)).toBe(true);
        expect(listenerCounts()).toEqual(baseline);
      } finally {
        process.exitCode = previous;
      }
    },
  );

  it('a second signal during cleanup is absorbed and cleanup still completes', async () => {
    const vendor = await pausedVendor();
    const { store, stateDir } = await signalSetup(vendor.script);
    const baseline = listenerCounts();
    const previous = process.exitCode;
    const tracker = new ProcessTracker();
    const cleanup = tracker.cleanup.bind(tracker);
    let cleanups = 0;
    tracker.cleanup = async (graceMs?: number) => {
      cleanups += 1;
      await cleanup(graceMs);
    };
    try {
      const removal = removeAccount(store, 'codex:personal', {
        purge: true,
        confirm: async () => true,
        platform: 'linux',
        tracker,
      }).catch((caught: unknown) => caught);
      await waitForFile(vendor.ready);
      const pid = await readVendorPid(vendor.pidFile);
      process.emit('SIGINT', 'SIGINT');
      // A second Ctrl+C while cleanup runs must not restore Node's default exit. SIGHUP
      // also has the hang-up observer that makes terminal write errors harmless.
      expect(listenerCounts()).toEqual(
        baseline.map((count, index) => count + (PURGE_SIGNALS[index] === 'SIGHUP' ? 2 : 1)),
      );
      process.emit('SIGINT', 'SIGINT');
      process.emit('SIGTERM', 'SIGTERM');
      const error = await removal;
      expect((error as UsageError).message).toBe(
        'Interrupted by SIGINT; logout was interrupted and may have completed; the directory was not moved',
      );
      expect(cleanups).toBe(1);
      await expectNothingMoved(store, stateDir);
      expect(await isGone(pid)).toBe(true);
      expect(process.exitCode).toBe(130);
      expect(listenerCounts()).toEqual(baseline);
    } finally {
      process.exitCode = previous;
    }
  });
});

describe('purge on macOS (darwin trash order)', () => {
  async function darwinPurgeSetup(script: string): Promise<{
    store: ConfigStore;
    stateDir: string;
    called: string;
    home: string;
  }> {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'accounts-darwin-')));
    const store = new ConfigStore(appPaths(home, { platform: 'darwin', env: {} }));
    const stateDir = join(store.paths.managedRoot, 'codex', 'personal');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, '.usage-owner'), JSON.stringify({ id: 'marker' }), {
      mode: 0o600,
    });
    const called = join(home, 'vendor-called');
    const fake = join(store.paths.dataDir, 'codex');
    await writeFile(fake, `#!/bin/sh\ntouch '${called}'\n${script}\n`);
    await chmod(fake, 0o700);
    const account: AccountConfig = {
      provider: 'codex',
      label: 'personal',
      stateDir,
      ownership: 'managed',
      ownershipMarker: 'marker',
    };
    await store.write(
      {
        ...DEFAULT_CONFIG,
        defaults: { ...DEFAULT_CONFIG.defaults, codexExecutable: fake },
        accounts: [account],
      },
      false,
    );
    return { store, stateDir, called, home };
  }

  const exists = (path: string): Promise<boolean> =>
    lstat(path).then(
      () => true,
      () => false,
    );

  it('darwin purge logs out, then moves state into ~/.Trash', async () => {
    const { store, stateDir, called, home } = await darwinPurgeSetup('exit 0');
    const result = await removeAccount(store, 'codex:personal', {
      purge: true,
      confirm: async () => true,
      platform: 'darwin',
    });
    expect(await exists(called)).toBe(true);
    expect(await exists(stateDir)).toBe(false);
    const entries = await readdir(join(home, '.Trash'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^usage-codex-personal-/);
    expect(await exists(join(home, '.Trash', entries[0] ?? '', '.usage-owner'))).toBe(true);
    expect(result.messages.join(' ')).toContain(
      `Moved ${stateDir} to ${join(home, '.Trash', entries[0] ?? '')}; it is recoverable from Trash.`,
    );
    expect((await store.load()).accounts).toHaveLength(0);
  });

  it('darwin logout failure creates no Trash and keeps the account', async () => {
    const { store, stateDir, called, home } = await darwinPurgeSetup('exit 1');
    await expect(
      removeAccount(store, 'codex:personal', {
        purge: true,
        confirm: async () => true,
        platform: 'darwin',
      }),
    ).rejects.toThrow('codex logout failed; state was not moved');
    expect(await exists(called)).toBe(true);
    expect(await exists(join(home, '.Trash'))).toBe(false);
    expect(await exists(join(stateDir, '.usage-owner'))).toBe(true);
    expect((await store.load()).accounts).toHaveLength(1);
  });

  it('darwin purge installs no signal listeners', async () => {
    const vendor = await pausedVendor();
    const { store } = await darwinPurgeSetup(vendor.script);
    const baseline = listenerCounts();
    const streamErrors = (): number[] =>
      [process.stdout, process.stderr].map((stream) => stream.listenerCount('error'));
    const streamBaseline = streamErrors();
    const removal = removeAccount(store, 'codex:personal', {
      purge: true,
      confirm: async () => true,
      platform: 'darwin',
    }).catch((caught: unknown) => caught);
    await waitForFile(vendor.ready);
    expect(listenerCounts()).toEqual(baseline);
    process.kill(await readVendorPid(vendor.pidFile), 'SIGTERM');
    expect(await removal).toMatchObject({
      message: 'codex logout failed; state was not moved',
    });
    expect(listenerCounts()).toEqual(baseline);
    expect(streamErrors()).toEqual(streamBaseline);
  });
});
