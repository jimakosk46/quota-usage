import { lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { UsageError } from './errors.js';
import type { Provider } from './types.js';

export interface AppPaths {
  homeDir: string;
  configDir: string;
  configFile: string;
  backupFile: string;
  dataDir: string;
  managedRoot: string;
  binDir: string;
  cacheDir: string;
  trashDir: string;
}

export interface AppPathsOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function appPaths(home = homedir(), options: AppPathsOptions = {}): AppPaths {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const linux = platform === 'linux';
  // XDG Base Directory: only non-empty absolute values count; others fall back.
  const base = (name: string, fallback: string): string => {
    const value = env[name];
    return linux && value && isAbsolute(value) ? value : join(home, fallback);
  };
  const configDir = join(base('XDG_CONFIG_HOME', '.config'), 'usage');
  const dataHome = base('XDG_DATA_HOME', join('.local', 'share'));
  const dataDir = join(dataHome, 'usage');
  return {
    homeDir: home,
    configDir,
    configFile: join(configDir, 'config.yaml'),
    backupFile: join(configDir, 'config.yaml.bak'),
    dataDir,
    managedRoot: join(dataDir, 'accounts'),
    binDir: join(dataDir, 'bin'),
    cacheDir: linux
      ? join(base('XDG_CACHE_HOME', '.cache'), 'usage')
      : join(home, 'Library', 'Caches', 'usage'),
    trashDir: linux ? join(dataHome, 'Trash') : join(home, '.Trash'),
  };
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

export async function canonicalExistingPath(path: string): Promise<string> {
  if (!isAbsolute(path)) path = resolve(path);
  try {
    return await realpath(path);
  } catch (error) {
    throw new UsageError('invalid_configuration', `State directory does not exist: ${path}`, {
      cause: error,
    });
  }
}

export function defaultStateDir(
  provider: Provider,
  env: NodeJS.ProcessEnv,
  home = homedir(),
): string {
  return provider === 'codex'
    ? resolve(env.CODEX_HOME ?? join(home, '.codex'))
    : resolve(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'));
}

export async function assertSafeManagedTarget(
  target: string,
  provider: Provider,
  label: string,
  paths: AppPaths,
): Promise<void> {
  const expected = join(paths.managedRoot, provider, label);
  if (target !== expected) {
    throw new UsageError(
      'invalid_configuration',
      `Managed path is not the expected account path: ${target}`,
    );
  }
  const rel = relative(paths.managedRoot, target);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split('/').length !== 2) {
    throw new UsageError('invalid_configuration', `Unsafe managed account path: ${target}`);
  }
  const stat = await lstat(target).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new UsageError(
      'invalid_configuration',
      `Managed account path is missing or unsafe: ${target}`,
    );
  }
  if ((await realpath(target)) !== target) {
    throw new UsageError(
      'invalid_configuration',
      `Managed account path contains a symlink: ${target}`,
    );
  }
}
