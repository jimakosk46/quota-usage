import { randomUUID } from 'node:crypto';
import { lstat, open, rename, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { UsageError } from './errors.js';
import { ensurePrivateDir, type AppPaths } from './paths.js';

export interface TrashMove {
  destination: string;
  /** Linux only: the reserved `info/<name>.trashinfo`, removed by `abort` or a failed `commit`. */
  reservation?: string;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

export interface TrashOptions {
  /** Test seam: chooses the trash flavour; defaults to process.platform. */
  platform?: NodeJS.Platform;
  now?: () => Date;
  /** Test seam for injecting filesystem failures. */
  fs?: {
    open?: typeof open;
    rename?: typeof rename;
    stat?: (path: string) => Promise<{ dev: number }>;
    lstat?: (path: string) => Promise<unknown>;
    unlink?: (path: string) => Promise<void>;
  };
}

const NAME_RETRIES = 5;
const UNRESERVED = /[A-Za-z0-9\-_.~/]/;

/** Percent-encodes a path per UTF-8 byte (RFC 2396), keeping `/` and unreserved characters. */
function encodeTrashPath(path: string): string {
  let out = '';
  for (const byte of Buffer.from(path, 'utf8')) {
    const char = String.fromCharCode(byte);
    out +=
      byte < 0x80 && UNRESERVED.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function localTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

const errnoCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const leftoverSuffix = (reservation: string): string =>
  `; the Trash reservation ${reservation} could not be removed`;

/**
 * Appends a note that `reservation` could not be removed to the primary error, so a
 * cleanup failure never replaces it. A `UsageError` is rebuilt with the same data;
 * any other `Error` keeps its class and errno `code` and only its message is extended.
 */
export function withLeftoverReservation(error: unknown, reservation: string): unknown {
  if (error instanceof UsageError) {
    const { code, message, retryable, provider, accountLabel, details } = error.data;
    return new UsageError(code, `${message}${leftoverSuffix(reservation)}`, {
      retryable,
      ...(provider === undefined ? {} : { provider }),
      ...(accountLabel === undefined ? {} : { accountLabel }),
      ...(details === undefined ? {} : { details }),
      cause: error,
    });
  }
  if (error instanceof Error) error.message += leftoverSuffix(reservation);
  return error;
}

const preparationFailure = (trashDir: string, error: unknown, reservation?: string): UsageError =>
  // Only the errno code is public; raw messages may carry unrelated detail.
  new UsageError(
    'invalid_configuration',
    `Could not prepare Trash ${trashDir}: ${errnoCode(error) ?? 'unknown error'}; the account was not logged out and its directory was not moved${reservation === undefined ? '' : leftoverSuffix(reservation)}`,
    { cause: error },
  );

/**
 * Prepares moving `source` into the user's Trash under `name` without touching
 * `source` until `commit`. macOS renames into `~/.Trash`; Linux follows the
 * freedesktop.org Trash specification (`files/` + `info/*.trashinfo`).
 */
export async function prepareTrash(
  paths: AppPaths,
  source: string,
  name: string,
  options: TrashOptions = {},
): Promise<TrashMove> {
  const platform = options.platform ?? process.platform;
  const renameFn = options.fs?.rename ?? rename;
  if (platform !== 'linux') {
    await ensurePrivateDir(paths.trashDir);
    const destination = join(paths.trashDir, name);
    return {
      destination,
      commit: () => renameFn(source, destination),
      abort: async () => {},
    };
  }

  try {
    return await prepareFreedesktop(paths, source, name, options, renameFn);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw preparationFailure(paths.trashDir, error);
  }
}

async function prepareFreedesktop(
  paths: AppPaths,
  source: string,
  name: string,
  options: TrashOptions,
  renameFn: typeof rename,
): Promise<TrashMove> {
  const openFn = options.fs?.open ?? open;
  const statFn = options.fs?.stat ?? stat;
  const lstatFn = options.fs?.lstat ?? lstat;
  const unlinkFn = options.fs?.unlink ?? unlink;
  const now = options.now ?? (() => new Date());
  const filesDir = join(paths.trashDir, 'files');
  const infoDir = join(paths.trashDir, 'info');
  await ensurePrivateDir(filesDir);
  await ensurePrivateDir(infoDir);
  const crossDevice = (tail: string, cause?: unknown): UsageError =>
    new UsageError(
      'invalid_configuration',
      `Trash ${paths.trashDir} is on another filesystem than ${source}; ${tail}`,
      { cause },
    );
  if ((await statFn(source)).dev !== (await statFn(filesDir)).dev) {
    throw crossDevice('the account was not logged out and its directory was not moved');
  }

  const body = `[Trash Info]\nPath=${encodeTrashPath(resolve(source))}\nDeletionDate=${localTimestamp(now())}\n`;
  for (let attempt = 0; attempt <= NAME_RETRIES; attempt += 1) {
    const candidate = attempt === 0 ? name : `${name}-${randomUUID()}`;
    const infoPath = join(infoDir, `${candidate}.trashinfo`);
    const destination = join(filesDir, candidate);
    let handle;
    try {
      handle = await openFn(infoPath, 'wx', 0o600);
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') continue;
      throw error;
    }
    const removeInfo = (): Promise<void> =>
      unlinkFn(infoPath).catch((error: unknown) => {
        if (errnoCode(error) !== 'ENOENT') throw error;
      });
    // Best-effort cleanup after a primary failure: returns the leftover path if it stays.
    const releaseInfo = (): Promise<string | undefined> =>
      removeInfo().then(
        () => undefined,
        () => infoPath,
      );
    try {
      await handle.writeFile(body);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      throw preparationFailure(paths.trashDir, error, await releaseInfo());
    }
    await handle.close();
    // A stale files/<name> without info would otherwise be replaced or block the rename.
    // Only ENOENT means absent; any other error refuses before logout. Node has no
    // RENAME_NOREPLACE, so a same-UID process could still create files/<name> between
    // this check and the rename; the random UUID in the name makes that practically impossible.
    let stale: boolean;
    try {
      await lstatFn(destination);
      stale = true;
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') {
        throw preparationFailure(paths.trashDir, error, await releaseInfo());
      }
      stale = false;
    }
    if (stale) {
      try {
        await removeInfo();
      } catch (error) {
        throw preparationFailure(paths.trashDir, error, infoPath);
      }
      continue;
    }
    return {
      destination,
      reservation: infoPath,
      commit: async () => {
        try {
          await renameFn(source, destination);
        } catch (error) {
          const primary =
            errnoCode(error) === 'EXDEV'
              ? crossDevice('the directory was not moved', error)
              : new UsageError(
                  'invalid_configuration',
                  `Could not move ${source} to ${destination}; the directory was not moved`,
                  { cause: error },
                );
          const leftover = await releaseInfo();
          throw leftover === undefined ? primary : withLeftoverReservation(primary, leftover);
        }
      },
      abort: removeInfo,
    };
  }
  throw new UsageError(
    'invalid_configuration',
    `Could not reserve a unique Trash entry for ${name}; the account was not logged out and its directory was not moved`,
  );
}
