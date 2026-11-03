import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  access,
} from 'node:fs/promises';
import { constants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountDirectoryName } from './selectors.js';
import { cachePath } from './cache.js';
import { ConfigStore, findAccount, validateLabel } from './config.js';
import { parseDuration } from './duration.js';
import { UsageError } from './errors.js';
import {
  compareVersions,
  parseVersion,
  resolveExecutable,
  vendorEnvironment,
} from './executable.js';
import {
  assertSafeManagedTarget,
  canonicalExistingPath,
  defaultStateDir,
  ensurePrivateDir,
} from './paths.js';
import { childOwned, guardSignals, ProcessTracker, runProcess } from './processes.js';
import { prepareTrash, withLeftoverReservation, type TrashOptions } from './trash.js';
import type { Confirm } from './prompt.js';
import { CodexAdapter, identityHash, maskEmail } from './providers/codex.js';
import { MIN_CLAUDE_MULTI_ACCOUNT_VERSION } from './providers/claude-live.js';
import type { AccountConfig, Provider, UsageConfig } from './types.js';

const MARKER_FILE = '.usage-owner';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function atomicJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  await chmod(path, mode);
}

async function interactiveVendor(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  tracker: ProcessTracker,
): Promise<void> {
  const child = spawn(executable, args, { shell: false, stdio: 'inherit', env });
  tracker.track(childOwned(child));
  const [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  if (code !== 0)
    throw new UsageError('provider_failure', `${executable} ${args.join(' ')} failed`);
}

async function claudeVersion(executable: string, tracker: ProcessTracker): Promise<string> {
  const result = await runProcess(executable, ['--version'], { timeoutMs: 2_000, tracker });
  const version = parseVersion(result.stdout);
  if (!version || compareVersions(version, MIN_CLAUDE_MULTI_ACCOUNT_VERSION) < 0) {
    throw new UsageError(
      'unsupported_vendor_version',
      `Claude Code ${version ?? 'unknown'} is unsupported for multi-account setup; ${MIN_CLAUDE_MULTI_ACCOUNT_VERSION} or newer is required`,
      { provider: 'claude' },
    );
  }
  return version;
}

async function validateClaudeLogin(
  executable: string,
  stateDir: string,
  tracker: ProcessTracker,
  claudeDefault = false,
): Promise<void> {
  await claudeVersion(executable, tracker);
  const result = await runProcess(executable, ['auth', 'status', '--json'], {
    env: vendorEnvironment('claude', stateDir, process.env, { claudeDefault }),
    timeoutMs: 5_000,
    tracker,
  });
  if (result.code !== 0) {
    throw new UsageError('logged_out_account', 'Claude Code considers this account logged out', {
      provider: 'claude',
    });
  }
  const status = JSON.parse(result.stdout) as Record<string, unknown>;
  if (status.loggedIn === false || status.authenticated === false) {
    throw new UsageError('logged_out_account', 'Claude Code considers this account logged out', {
      provider: 'claude',
    });
  }
}

function settingsPath(account: Pick<AccountConfig, 'stateDir'>): string {
  return join(account.stateDir, 'settings.json');
}

async function readSettings(
  account: Pick<AccountConfig, 'stateDir'>,
): Promise<Record<string, unknown>> {
  return readFile(settingsPath(account), 'utf8')
    .then((text) => JSON.parse(text) as Record<string, unknown>)
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new UsageError(
        'invalid_configuration',
        `Cannot read Claude settings: ${settingsPath(account)}`,
        {
          cause: error,
        },
      );
    });
}

export function collectorPaths(
  store: ConfigStore,
  label: string,
): {
  helper: string;
  previous: string;
  cache: string;
} {
  return {
    helper: join(store.paths.binDir, 'claude-statusline'),
    previous: join(store.paths.binDir, `claude-${label}-previous.json`),
    cache: cachePath(store.paths, 'claude', label),
  };
}

export async function installClaudeCollector(
  account: AccountConfig,
  store: ConfigStore,
  confirm: Confirm,
): Promise<AccountConfig> {
  const settings = await readSettings(account);
  const previous = settings.statusLine;
  const files = collectorPaths(store, account.label);
  const command = `${shellQuote(files.helper)} --label ${shellQuote(account.label)} --cache ${shellQuote(files.cache)}${
    previous === undefined ? '' : ` --previous-file ${shellQuote(files.previous)}`
  }`;
  const preview = [
    `Claude settings: ${settingsPath(account)}`,
    `Current statusLine: ${previous === undefined ? '(none)' : JSON.stringify(previous)}`,
    `New statusLine command: ${command}`,
  ].join('\n');
  if (!(await confirm(`${preview}\nInstall this collector?`))) {
    throw new UsageError(
      'invalid_configuration',
      'Claude collector installation was not confirmed',
    );
  }
  await ensurePrivateDir(store.paths.binDir);
  const adjacentHelper = fileURLToPath(new URL('./statusline-helper.js', import.meta.url));
  const builtHelper = await access(adjacentHelper).then(
    () => adjacentHelper,
    () => fileURLToPath(new URL('../dist/statusline-helper.js', import.meta.url)),
  );
  await copyFile(builtHelper, files.helper);
  await chmod(files.helper, 0o700);
  if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
    const priorCommand = (previous as Record<string, unknown>).command;
    if (typeof priorCommand === 'string')
      await atomicJson(files.previous, { command: priorCommand });
  }
  const next = { ...settings, statusLine: { type: 'command', command } };
  await atomicJson(settingsPath(account), next);
  return {
    ...account,
    claudeCollector: {
      wrapperCommand: command,
      ...(previous === undefined ? {} : { previousStatusLine: previous }),
    },
  };
}

export async function restoreClaudeCollector(
  account: AccountConfig,
): Promise<{ restored: boolean; drift?: string }> {
  if (!account.claudeCollector) return { restored: true };
  const settings = await readSettings(account);
  const current = settings.statusLine;
  const matches =
    !!current &&
    typeof current === 'object' &&
    !Array.isArray(current) &&
    (current as Record<string, unknown>).command === account.claudeCollector.wrapperCommand;
  if (!matches) {
    return {
      restored: false,
      drift: `Claude settings changed after setup. Remove the statusLine whose command is ${JSON.stringify(account.claudeCollector.wrapperCommand)} manually if it is still present.`,
    };
  }
  const next = { ...settings };
  if (account.claudeCollector.previousStatusLine === undefined) delete next.statusLine;
  else next.statusLine = account.claudeCollector.previousStatusLine;
  await atomicJson(settingsPath(account), next);
  return { restored: true };
}

export interface AddOptions {
  useDefault?: boolean;
  stateDir?: string;
  create?: boolean;
  confirm: Confirm;
  env?: NodeJS.ProcessEnv;
  tracker?: ProcessTracker;
}

export async function addAccount(
  store: ConfigStore,
  provider: Provider,
  label: string,
  options: AddOptions,
): Promise<AccountConfig> {
  validateLabel(label);
  const sources = [options.useDefault, options.stateDir !== undefined, options.create].filter(
    Boolean,
  ).length;
  if (sources !== 1) {
    throw new UsageError(
      'invalid_configuration',
      'Choose exactly one of --default, --state-dir, or --create',
    );
  }
  const config = await store.load({ create: true });
  if (config.accounts.some((account) => account.provider === provider && account.label === label)) {
    throw new UsageError('invalid_configuration', `Account already exists: ${provider}:${label}`);
  }
  const tracker = options.tracker ?? new ProcessTracker();
  const env = options.env ?? process.env;
  const executable = await resolveExecutable(
    provider,
    provider === 'codex' ? config.defaults.codexExecutable : config.defaults.claudeExecutable,
    provider,
    env,
  );
  let stateDir: string;
  let ownership: AccountConfig['ownership'];
  let ownershipMarker: string | undefined;
  const claudeDefault =
    provider === 'claude' && options.useDefault === true && env.CLAUDE_CONFIG_DIR === undefined;
  if (options.create) {
    stateDir = join(store.paths.managedRoot, provider, label);
    if (
      await lstat(stateDir).then(
        () => true,
        () => false,
      )
    ) {
      throw new UsageError(
        'invalid_configuration',
        `Managed account directory already exists: ${stateDir}`,
      );
    }
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    ownership = 'managed';
    ownershipMarker = randomUUID();
    await atomicJson(join(stateDir, MARKER_FILE), { id: ownershipMarker, provider, label });
    if (provider === 'codex') {
      await interactiveVendor(
        executable,
        ['login'],
        vendorEnvironment('codex', stateDir, env),
        tracker,
      );
    } else {
      await claudeVersion(executable, tracker);
      await interactiveVendor(
        executable,
        ['auth', 'login'],
        vendorEnvironment('claude', stateDir, env),
        tracker,
      );
    }
  } else {
    const requested = options.useDefault
      ? defaultStateDir(provider, env)
      : resolve(options.stateDir as string);
    stateDir = await canonicalExistingPath(requested);
    ownership = 'external';
  }
  if (
    config.accounts.some(
      (account) => account.provider === provider && account.stateDir === stateDir,
    )
  ) {
    throw new UsageError(
      'invalid_configuration',
      `Another ${provider} account already uses ${stateDir}`,
    );
  }
  let account: AccountConfig = {
    provider,
    label,
    stateDir,
    ownership,
    ...(claudeDefault ? { claudeDefault: true } : {}),
    ...(ownershipMarker ? { ownershipMarker } : {}),
  };
  if (provider === 'codex') {
    const adapter = new CodexAdapter(executable, tracker);
    await adapter.version();
    const identity = await adapter.readIdentity(
      account,
      parseDuration(config.defaults.codexTimeout),
    );
    if (!identity.email) {
      throw new UsageError(
        'invalid_configuration',
        'Codex did not provide an email identity for this account',
      );
    }
    account = {
      ...account,
      identityHash: identityHash(identity.email),
      identityMetadata: {
        maskedEmail: maskEmail(identity.email),
        ...(identity.plan ? { plan: identity.plan } : {}),
      },
    };
  } else {
    await validateClaudeLogin(executable, stateDir, tracker, claudeDefault);
    account = await installClaudeCollector(account, store, options.confirm);
  }
  await store.write({ ...config, accounts: [...config.accounts, account] });
  return account;
}

export function listAccounts(config: UsageConfig, verbose = false): string {
  if (!config.accounts.length) return 'No accounts configured.';
  return [...config.accounts]
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label))
    .map((account) => {
      const base = `${accountDirectoryName(account)}  ${account.discoveryKey ? 'auto-detected' : account.ownership}`;
      if (!verbose) return base;
      const metadata = account.identityMetadata
        ? `  unverified metadata: ${[account.identityMetadata.maskedEmail, account.identityMetadata.plan].filter(Boolean).join(', ')}`
        : '';
      return `${base}\n  alias: ${account.provider}:${account.label}\n  state: ${account.stateDir}${metadata}`;
    })
    .join('\n');
}

async function markerMatches(account: AccountConfig): Promise<boolean> {
  if (!account.ownershipMarker) return false;
  const markerPath = join(account.stateDir, MARKER_FILE);
  const markerInfo = await lstat(markerPath).catch(() => undefined);
  if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) return false;
  const marker = await readFile(markerPath, 'utf8')
    .then((text) => JSON.parse(text) as { id?: string })
    .catch(() => undefined);
  return marker?.id === account.ownershipMarker;
}

const PURGE_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const ignoreStreamError = (): void => {};

/**
 * After SIGHUP the terminal is gone, so a later stdout/stderr write fails asynchronously
 * (EIO/EPIPE). Without a listener that 'error' becomes an uncaught exception and changes
 * the exit status after cleanup. Idempotent; the listener stays until the process exits.
 */
function ignoreTerminalWriteErrors(): void {
  for (const stream of [process.stdout, process.stderr]) {
    if (!stream.listeners('error').includes(ignoreStreamError)) {
      stream.on('error', ignoreStreamError);
    }
  }
}

export async function removeAccount(
  store: ConfigStore,
  selector: string,
  options: {
    purge?: boolean;
    confirm: Confirm;
    tracker?: ProcessTracker;
    /** Test seam: chooses the trash flavour and preflight order; defaults to process.platform. */
    platform?: NodeJS.Platform;
    /** Test seam for injecting Trash filesystem failures. */
    trashFs?: TrashOptions['fs'];
  },
): Promise<{ messages: string[] }> {
  const match = /^(codex|claude):([a-z0-9_-]+)$/.exec(selector);
  if (!match)
    throw new UsageError('invalid_configuration', `Invalid account selector: ${selector}`);
  const provider = match[1] as Provider;
  const label = match[2] as string;
  const config = await store.load();
  const account = findAccount(config, provider, label);
  const messages: string[] = [];
  if (account.provider === 'claude') {
    const restored = await restoreClaudeCollector(account);
    if (restored.drift) messages.push(restored.drift);
  }
  if (options.purge) {
    if (account.ownership !== 'managed') {
      throw new UsageError('invalid_configuration', 'Only managed account state can be purged');
    }
    await assertSafeManagedTarget(account.stateDir, provider, label, store.paths);
    if (!(await markerMatches(account))) {
      throw new UsageError(
        'invalid_configuration',
        'Ownership marker is missing or does not match',
      );
    }
    if (!(await options.confirm(`Log out and move ${account.stateDir} to Trash?`))) {
      throw new UsageError('invalid_configuration', 'Purge was not confirmed');
    }
    const tracker = options.tracker ?? new ProcessTracker();
    const executable = await resolveExecutable(
      provider,
      provider === 'codex' ? config.defaults.codexExecutable : config.defaults.claudeExecutable,
      provider,
    );
    const platform = options.platform ?? process.platform;
    const trashName = `usage-${provider}-${label}-${randomUUID()}`;
    const trashOptions: TrashOptions = {
      platform,
      ...(options.trashFs === undefined ? {} : { fs: options.trashFs }),
    };
    const cancel = new AbortController();
    // Linux holds a Trash reservation from preparation until commit; a signal in that
    // window stops the owned logout and releases the reservation instead of orphaning it.
    let unguard: (() => void) | undefined;
    if (platform === 'linux') {
      const removeGuard = guardSignals(PURGE_SIGNALS, (signal) => {
        cancel.abort(signal);
        process.exitCode = 128 + constants.signals[signal];
        void tracker.cleanup();
      });
      // Any SIGHUP, not only the first signal, means the terminal is gone; this observer
      // neither cancels again nor changes the first signal's exit status.
      const onHangup = (): void => {
        ignoreTerminalWriteErrors();
      };
      process.on('SIGHUP', onHangup);
      unguard = () => {
        removeGuard();
        process.off('SIGHUP', onHangup);
      };
    }
    // A function, not a property read: TypeScript would keep the narrowing across awaits.
    const cancelled = (): boolean => cancel.signal.aborted;
    const interrupted = (tail: string): UsageError =>
      new UsageError('provider_failure', `Interrupted by ${String(cancel.signal.reason)}; ${tail}`);
    try {
      // Linux validates and reserves the freedesktop Trash entry before logging out, so
      // an unusable Trash is refused before the vendor session is touched. SIGKILL or
      // power loss in this window can still leave an orphan .trashinfo; it is harmless,
      // because its Path= names a directory that still exists at its original place.
      const preflight =
        platform === 'linux'
          ? await prepareTrash(store.paths, account.stateDir, trashName, trashOptions)
          : undefined;
      try {
        if (cancelled()) {
          throw interrupted('the account was not logged out and its directory was not moved');
        }
        const logout = await runProcess(
          executable,
          provider === 'codex' ? ['logout'] : ['auth', 'logout'],
          {
            env: vendorEnvironment(provider, account.stateDir, process.env, {
              claudeDefault: account.claudeDefault,
            }),
            timeoutMs: 30_000,
            tracker,
          },
        );
        // Checked before the exit code: a vendor may exit 0 on the same signal.
        if (cancelled()) {
          // Neither exit code proves the outcome: a vendor may revoke, then be killed.
          throw interrupted(
            'logout was interrupted and may have completed; the directory was not moved',
          );
        }
        if (logout.code !== 0) {
          throw new UsageError(
            'provider_failure',
            `${provider} logout failed; state was not moved`,
          );
        }
      } catch (error) {
        // Release the reservation on every logout failure (exit code, timeout, spawn error,
        // signal). The logout error stays primary; if the release fails, it names the leftover file.
        const leftover = await preflight?.abort().then(
          () => undefined,
          () => preflight.reservation,
        );
        throw leftover === undefined ? error : withLeftoverReservation(error, leftover);
      }
      // On Linux `preflight` exists, so nothing awaits between the last cancellation check
      // and commit(); once the rename has started it is awaited and, if it succeeds, the
      // reservation describes a real trashed item. The guard stays until commit() settles.
      const move =
        preflight ?? (await prepareTrash(store.paths, account.stateDir, trashName, trashOptions));
      await move.commit();
      messages.push(
        `Moved ${account.stateDir} to ${move.destination}; it is recoverable from Trash.`,
      );
    } finally {
      unguard?.();
    }
  }
  const accounts = config.accounts.filter(
    (item) => item.provider !== provider || item.label !== label,
  );
  await store.write({ ...config, accounts });
  await unlink(cachePath(store.paths, provider, label)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  if (provider === 'claude') {
    await unlink(collectorPaths(store, label).previous).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  messages.push(`Removed ${selector} from configuration; vendor credentials were left untouched.`);
  return { messages };
}

export async function revalidateCodex(
  store: ConfigStore,
  label: string,
  confirm: Confirm,
  tracker = new ProcessTracker(),
): Promise<AccountConfig> {
  const config = await store.load();
  const account = findAccount(config, 'codex', label);
  const executable = await resolveExecutable('codex', config.defaults.codexExecutable, 'codex');
  const adapter = new CodexAdapter(executable, tracker);
  await adapter.version();
  const identity = await adapter.readIdentity(account, parseDuration(config.defaults.codexTimeout));
  if (!identity.email)
    throw new UsageError('invalid_configuration', 'Codex did not provide an email identity');
  const nextMetadata = {
    maskedEmail: maskEmail(identity.email),
    ...(identity.plan ? { plan: identity.plan } : {}),
  };
  const preview = `Old unverified metadata: ${JSON.stringify(account.identityMetadata ?? {})}\nNew unverified metadata: ${JSON.stringify(nextMetadata)}`;
  if (!(await confirm(`${preview}\nRecord the new identity fingerprint?`))) {
    throw new UsageError('invalid_configuration', 'Identity revalidation was not confirmed');
  }
  const updated: AccountConfig = {
    ...account,
    identityHash: identityHash(identity.email),
    identityMetadata: nextMetadata,
  };
  await store.write({
    ...config,
    accounts: config.accounts.map((item) =>
      item.provider === 'codex' && item.label === label ? updated : item,
    ),
  });
  return updated;
}

export async function canonicalStateStillMatches(account: AccountConfig): Promise<boolean> {
  return realpath(account.stateDir).then(
    (path) => path === account.stateDir,
    () => false,
  );
}
