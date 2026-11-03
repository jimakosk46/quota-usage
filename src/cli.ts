#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import { addAccount, listAccounts, removeAccount, revalidateCodex } from './accounts.js';
import { startAutoUpdate } from './auto-update.js';
import { collectUsage } from './collect.js';
import { ConfigStore } from './config.js';
import { discoverAccounts, loadAccountConfig } from './discovery.js';
import { doctor, renderDoctor } from './doctor.js';
import { parseDuration } from './duration.js';
import { asUsageError, UsageError } from './errors.js';
import { appPaths } from './paths.js';
import { ProcessTracker } from './processes.js';
import { confirm } from './prompt.js';
import { renderHuman, type ColorMode } from './render-human.js';
import { publicDocument, renderJson } from './render-json.js';
import { runTui, useTui } from './tui.js';
import { uninstall, uninstallPreview } from './uninstall.js';
import type { CollectionMode } from './types.js';

interface GlobalOptions {
  cached?: boolean;
  update: boolean;
  discover: boolean;
  tui?: boolean;
  plain?: boolean;
  refresh: string;
  json?: boolean;
  verbose?: boolean;
  debugFile?: string;
  color: ColorMode;
  codexTimeout?: string;
  claudeTimeout?: string;
}

async function debugLogger(path: string | undefined): Promise<(message: string) => void> {
  if (!path) return () => undefined;
  const handle = await open(resolve(path), 'a', 0o600);
  await handle.chmod(0o600);
  return (message) => {
    void handle.appendFile(`${new Date().toISOString()} ${message.replace(/[\r\n]+/g, ' ')}\n`);
  };
}

const program = new Command()
  .name('usage')
  .description('Report Codex and Claude Code subscription quota usage across accounts')
  .version('0.1.0')
  .argument(
    '[selectors...]',
    'accounts or providers to collect (for example codex:personal claude)',
  )
  .option('--no-update', 'skip background repository update and rebuild')
  .option('--no-discover', 'use only explicitly registered accounts')
  .option('--cached', 'read caches only; start no vendor process and perform no version check')
  .addOption(new Option('--json', 'emit one versioned JSON document').conflicts('tui'))
  .addOption(
    new Option('--tui', 'auto-refresh dashboard (default on interactive terminals)').conflicts([
      'plain',
      'json',
    ]),
  )
  .addOption(new Option('--plain', 'print one human-readable snapshot').conflicts('tui'))
  .option('--refresh <duration>', 'dashboard refresh interval', '1m')
  .option('--verbose', 'write safe diagnostics to stderr')
  .option('--debug-file <path>', 'append redacted diagnostics to an owner-only file')
  .addOption(
    new Option('--color <mode>', 'color output')
      .choices(['always', 'auto', 'never'])
      .default('auto'),
  )
  .option('--codex-timeout <duration>', 'Codex account timeout (for example 10s or 1m)')
  .option('--claude-timeout <duration>', 'Claude account timeout (for example 30s or 1m)');

program.action(async (selectors: string[], options: GlobalOptions) => {
  const logDebug = await debugLogger(options.debugFile);
  const update = startAutoUpdate({ enabled: options.update });
  const tracker = new ProcessTracker();
  const removeSignals = tracker.installSignalHandlers(() => update.cancel());
  let dashboardActive = false;
  const deferredVerbose: string[] = [];
  const verbose = (message: string): void => {
    logDebug(message);
    if (options.verbose) {
      if (dashboardActive) {
        deferredVerbose.push(message);
        // Keep long dashboard sessions bounded; the debug file still records every entry.
        if (deferredVerbose.length > 1_000) deferredVerbose.shift();
      } else process.stderr.write(`${message}\n`);
    }
  };
  try {
    if (options.codexTimeout) parseDuration(options.codexTimeout);
    if (options.claudeTimeout) parseDuration(options.claudeTimeout);
    const intervalMs = parseDuration(options.refresh);
    if (intervalMs < 1_000 || intervalMs > 2_147_483_647)
      throw new UsageError('invalid_configuration', 'Refresh interval must be between 1s and 24d');
    if (options.tui && !(process.stdin.isTTY && process.stdout.isTTY))
      throw new UsageError('invalid_configuration', '--tui requires interactive input and output');
    const mode: CollectionMode = options.cached ? 'cached' : 'default';
    const store = new ConfigStore(appPaths());
    verbose(`mode=${mode}`);
    const collect = async () =>
      collectUsage({
        config: await loadAccountConfig(store),
        paths: store.paths,
        discover: options.discover,
        selectors,
        mode,
        tracker,
        ...(options.codexTimeout ? { codexTimeout: options.codexTimeout } : {}),
        ...(options.claudeTimeout ? { claudeTimeout: options.claudeTimeout } : {}),
        verbose,
      });
    if (useTui(options, process.stdin.isTTY, process.stdout.isTTY)) {
      dashboardActive = true;
      let summary;
      try {
        summary = await runTui({ collect, intervalMs, color: options.color });
      } finally {
        dashboardActive = false;
        for (const message of deferredVerbose) process.stderr.write(`${message}\n`);
      }
      if (process.exitCode !== 130 && process.exitCode !== 143)
        process.exitCode = summary?.exitCode ?? 0;
      return;
    }
    const summary = await collect();
    if (options.json) {
      process.stdout.write(renderJson(publicDocument(mode, summary.results, summary.errors)));
    } else {
      const output = renderHuman(summary.results, summary.errors, {
        color: options.color,
        tty: process.stdout.isTTY,
      });
      if (output) process.stdout.write(`${output}\n`);
      for (const result of summary.results) {
        for (const warning of result.warnings ?? [])
          process.stderr.write(`${result.provider}:${result.label}: ${warning}\n`);
      }
    }
    process.exitCode = summary.exitCode;
  } catch (error) {
    const data = asUsageError(error, { code: 'provider_failure', retryable: false });
    logDebug(`${data.code}: ${data.message}`);
    if (options.json) {
      process.stdout.write(
        renderJson(publicDocument(options.cached ? 'cached' : 'default', [], [data])),
      );
    } else process.stderr.write(`usage: ${data.message}\n`);
    process.exitCode = 2;
  } finally {
    update.cancel();
    await Promise.all([tracker.cleanup(), update.close()]);
    removeSignals();
  }
});

const accounts = program.command('accounts').description('Manage registered provider accounts');

accounts
  .command('add')
  .description('Register an existing or new provider account')
  .argument('<provider>', 'codex or claude')
  .argument('<label>', 'lowercase local account label')
  .option('--default', 'register the effective default vendor state directory')
  .option('--state-dir <path>', 'register an existing stable vendor state directory')
  .option('--create', 'create managed state and launch the official vendor login')
  .action(
    async (
      provider: string,
      label: string,
      options: { default?: boolean; stateDir?: string; create?: boolean },
    ) => {
      try {
        if (provider !== 'codex' && provider !== 'claude') {
          throw new UsageError('invalid_configuration', 'Provider must be codex or claude');
        }
        const tracker = new ProcessTracker();
        const account = await addAccount(new ConfigStore(), provider, label, {
          ...(options.default === undefined ? {} : { useDefault: options.default }),
          ...(options.stateDir ? { stateDir: options.stateDir } : {}),
          ...(options.create === undefined ? {} : { create: options.create }),
          confirm,
          tracker,
        });
        await tracker.cleanup();
        process.stdout.write(
          `Added ${account.provider}:${account.label} (${account.ownership}).\n`,
        );
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 2;
      }
    },
  );

accounts
  .command('list')
  .description('List registered and auto-detected accounts')
  .option('--verbose', 'show safe paths and unverified provider metadata')
  .action(async (options: { verbose?: boolean }) => {
    try {
      const store = new ConfigStore();
      const config = await loadAccountConfig(store);
      const inventory = await discoverAccounts(
        config.accounts,
        store.paths.homeDir,
        program.opts<GlobalOptions>().discover,
      );
      process.stdout.write(
        `${listAccounts({ ...config, accounts: inventory.accounts }, options.verbose || program.opts<GlobalOptions>().verbose)}\n`,
      );
      for (const error of inventory.errors) process.stderr.write(`${error.message}\n`);
      if (inventory.errors.length) process.exitCode = inventory.accounts.length ? 1 : 2;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  });

accounts
  .command('remove')
  .description('Remove registration; optionally log out and move managed state to Trash')
  .argument('<account>', 'provider:label')
  .option('--purge', 'purge only verified managed state after official vendor logout')
  .action(async (selector: string, options: { purge?: boolean }) => {
    try {
      const result = await removeAccount(new ConfigStore(), selector, {
        ...(options.purge === undefined ? {} : { purge: options.purge }),
        confirm,
      });
      process.stdout.write(`${result.messages.join('\n')}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      // An interrupted Linux purge has already set 128 + signal number.
      if (![129, 130, 143].includes(Number(process.exitCode))) process.exitCode = 2;
    }
  });

accounts
  .command('revalidate')
  .description('Confirm and record a changed Codex account identity')
  .argument('<account>', 'codex:label')
  .action(async (selector: string) => {
    try {
      const match = /^codex:([a-z0-9_-]+)$/.exec(selector);
      if (!match)
        throw new UsageError('invalid_configuration', 'Revalidation requires codex:<label>');
      await revalidateCodex(new ConfigStore(), match[1] as string, confirm);
      process.stdout.write(`Revalidated ${selector}.\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  });

program
  .command('doctor')
  .description('Run read-only configuration, vendor, collector, cache, and ownership checks')
  .action(async () => {
    const checks = await doctor(new ConfigStore(), {
      discover: program.opts<GlobalOptions>().discover,
    });
    process.stdout.write(`${renderDoctor(checks)}\n`);
    process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
  });

program
  .command('uninstall')
  .description('Preview and prepare local usage data for npm package removal')
  .option('--preview', 'print planned actions without changing anything')
  .action(async (options: { preview?: boolean }) => {
    try {
      const store = new ConfigStore();
      const messages = options.preview
        ? await uninstallPreview(store)
        : await uninstall(store, confirm);
      process.stdout.write(
        `${messages.map((message) => (options.preview ? `- ${message}` : message)).join('\n')}\n`,
      );
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  });

program.showHelpAfterError();
await program.parseAsync(process.argv);
