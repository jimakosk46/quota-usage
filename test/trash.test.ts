import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors.js';
import { appPaths, type AppPaths } from '../src/paths.js';
import { prepareTrash } from '../src/trash.js';

const now = (): Date => new Date(2026, 10, 2, 18, 30, 0);

async function setup(
  platform: NodeJS.Platform = 'linux',
  sourceName = 'src',
): Promise<{ paths: AppPaths; source: string }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'trash-')));
  const paths = appPaths(home, { platform, env: {} });
  const source = join(home, sourceName);
  await mkdir(source);
  await writeFile(join(source, 'state'), 'vendor state');
  return { paths, source };
}

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe('freedesktop trash (linux)', () => {
  it('writes a valid trashinfo pair', async () => {
    const { paths, source } = await setup();
    const move = await prepareTrash(paths, source, 'usage-codex-x', { platform: 'linux', now });
    expect(move.destination).toBe(join(paths.trashDir, 'files', 'usage-codex-x'));
    await move.commit();
    expect(await readFile(join(paths.trashDir, 'files', 'usage-codex-x', 'state'), 'utf8')).toBe(
      'vendor state',
    );
    expect(await exists(source)).toBe(false);
    expect(await readFile(join(paths.trashDir, 'info', 'usage-codex-x.trashinfo'), 'utf8')).toBe(
      `[Trash Info]\nPath=${source}\nDeletionDate=2026-11-02T18:30:00\n`,
    );
    expect(
      (await lstat(join(paths.trashDir, 'info', 'usage-codex-x.trashinfo'))).mode & 0o777,
    ).toBe(0o600);
  });

  it('percent-encodes the original path', async () => {
    const { paths, source } = await setup('linux', 'a b%ä');
    const move = await prepareTrash(paths, source, 'n', { platform: 'linux', now });
    const info = await readFile(join(paths.trashDir, 'info', 'n.trashinfo'), 'utf8');
    expect(info).toContain(`Path=${paths.homeDir}/a%20b%25%C3%A4\n`);
    await move.abort();
  });

  it('reserves info files exclusively', async () => {
    const { paths, source } = await setup();
    const taken = join(paths.trashDir, 'info', 'usage-codex-x.trashinfo');
    await mkdir(join(paths.trashDir, 'info'), { recursive: true });
    await writeFile(taken, 'someone else');
    const move = await prepareTrash(paths, source, 'usage-codex-x', { platform: 'linux', now });
    expect(move.destination).not.toBe(join(paths.trashDir, 'files', 'usage-codex-x'));
    await move.commit();
    expect(await readFile(taken, 'utf8')).toBe('someone else');
    const infos = (await readdir(join(paths.trashDir, 'info'))).sort();
    expect(infos).toHaveLength(2);
    const name = move.destination.split('/').at(-1);
    expect(infos).toContain(`${name}.trashinfo`);
  });

  it('creates trash dirs private', async () => {
    const { paths, source } = await setup();
    const move = await prepareTrash(paths, source, 'n', { platform: 'linux', now });
    expect((await lstat(join(paths.trashDir, 'files'))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(paths.trashDir, 'info'))).mode & 0o777).toBe(0o700);
    await move.abort();
    expect(await readdir(join(paths.trashDir, 'info'))).toEqual([]);
  });

  it('rename failure keeps source and removes info', async () => {
    const { paths, source } = await setup();
    const move = await prepareTrash(paths, source, 'n', {
      platform: 'linux',
      now,
      fs: {
        rename: async () => {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        },
      },
    });
    const error = await move.commit().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain('was not moved');
    expect(await exists(source)).toBe(true);
    expect(await readdir(join(paths.trashDir, 'info'))).toEqual([]);
  });

  it('reports a cross-device rename at commit as another filesystem', async () => {
    const { paths, source } = await setup();
    const move = await prepareTrash(paths, source, 'n', {
      platform: 'linux',
      now,
      fs: {
        rename: async () => {
          throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
        },
      },
    });
    await expect(move.commit()).rejects.toThrow(/another filesystem.*was not moved/);
    expect(await exists(source)).toBe(true);
    expect(await readdir(join(paths.trashDir, 'info'))).toEqual([]);
  });

  it('another filesystem is refused before any entry is reserved', async () => {
    const { paths, source } = await setup();
    let dev = 0;
    const error = await prepareTrash(paths, source, 'n', {
      platform: 'linux',
      now,
      fs: { stat: async () => ({ dev: dev++ }) },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).data.code).toBe('invalid_configuration');
    expect((error as UsageError).message).toContain('another filesystem');
    expect((error as UsageError).message).toContain(
      'the account was not logged out and its directory was not moved',
    );
    expect(await readdir(join(paths.trashDir, 'info'))).toEqual([]);
    expect(await exists(source)).toBe(true);
  });

  it('gives up after repeated name collisions', async () => {
    const { paths, source } = await setup();
    const move = await prepareTrash(paths, source, 'n', {
      platform: 'linux',
      now,
      fs: {
        open: async () => {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        },
      },
    }).catch((caught: unknown) => caught);
    expect(move).toBeInstanceOf(UsageError);
    expect(await exists(source)).toBe(true);
  });
});

describe('freedesktop trash failures (linux)', () => {
  it('a failed trashinfo write leaves nothing behind', async () => {
    const { paths, source } = await setup();
    const error = await prepareTrash(paths, source, 'n', {
      platform: 'linux',
      now,
      fs: {
        open: async (...args: Parameters<typeof open>) => {
          const handle = await open(...args);
          return Object.assign(handle, {
            writeFile: async () => {
              throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            },
          });
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toBe(
      `Could not prepare Trash ${paths.trashDir}: ENOSPC; the account was not logged out and its directory was not moved`,
    );
    expect(await readdir(join(paths.trashDir, 'info'))).toEqual([]);
    expect(await exists(join(source, 'state'))).toBe(true);
  });

  it('skips a stale files entry without touching it', async () => {
    const { paths, source } = await setup();
    const stale = join(paths.trashDir, 'files', 'n');
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, 'old'), 'older trash');
    const move = await prepareTrash(paths, source, 'n', { platform: 'linux', now });
    expect(move.destination).not.toBe(stale);
    await move.commit();
    expect(await readFile(join(stale, 'old'), 'utf8')).toBe('older trash');
    const name = move.destination.split('/').at(-1);
    expect(await readdir(join(paths.trashDir, 'info'))).toEqual([`${name}.trashinfo`]);
  });

  it('wraps a non-EEXIST open error without exposing its message', async () => {
    const { paths, source } = await setup();
    const error = await prepareTrash(paths, source, 'n', {
      platform: 'linux',
      now,
      fs: {
        open: async () => {
          throw Object.assign(new Error('secret detail'), { code: 'EACCES' });
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).data.code).toBe('invalid_configuration');
    expect((error as UsageError).message).toBe(
      `Could not prepare Trash ${paths.trashDir}: EACCES; the account was not logged out and its directory was not moved`,
    );
    expect(await exists(source)).toBe(true);
  });
});

describe('freedesktop trash cleanup faults (linux)', () => {
  const eacces = (): Error => Object.assign(new Error('secret detail'), { code: 'EACCES' });

  it('treats only ENOENT as an absent destination', async () => {
    const { paths, source } = await setup();
    const error = await prepareTrash(paths, source, 'n', {
      platform: 'linux',
      now,
      fs: {
        lstat: async () => {
          throw eacces();
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).data.code).toBe('invalid_configuration');
    expect((error as UsageError).message).toBe(
      `Could not prepare Trash ${paths.trashDir}: EACCES; the account was not logged out and its directory was not moved`,
    );
    expect(await readdir(join(paths.trashDir, 'info'))).toEqual([]);
    expect(await exists(join(source, 'state'))).toBe(true);
  });

  it('names the leftover trashinfo when a failed write cannot be cleaned up', async () => {
    const { paths, source } = await setup();
    const error = await prepareTrash(paths, source, 'n', {
      platform: 'linux',
      now,
      fs: {
        open: async (...args: Parameters<typeof open>) => {
          const handle = await open(...args);
          return Object.assign(handle, {
            writeFile: async () => {
              throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            },
          });
        },
        unlink: async () => {
          throw eacces();
        },
      },
    }).catch((caught: unknown) => caught);
    const info = join(paths.trashDir, 'info', 'n.trashinfo');
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toBe(
      `Could not prepare Trash ${paths.trashDir}: ENOSPC; the account was not logged out and its directory was not moved; the Trash reservation ${info} could not be removed`,
    );
    expect(await exists(info)).toBe(true);
  });

  const failingClose = async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    return Object.assign(handle, {
      close: async () => {
        await close();
        throw Object.assign(new Error('secret detail'), { code: 'EIO' });
      },
    });
  };

  it('releases the reservation when closing the trashinfo fails', async () => {
    const { paths, source } = await setup();
    const error = await prepareTrash(paths, source, 'n', {
      platform: 'linux',
      now,
      fs: { open: failingClose },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).data.code).toBe('invalid_configuration');
    expect((error as UsageError).message).toBe(
      `Could not prepare Trash ${paths.trashDir}: EIO; the account was not logged out and its directory was not moved`,
    );
    expect(await readdir(join(paths.trashDir, 'info'))).toEqual([]);
    expect(await exists(join(source, 'state'))).toBe(true);
  });

  it('names the leftover trashinfo when a failed close cannot be cleaned up', async () => {
    const { paths, source } = await setup();
    const error = await prepareTrash(paths, source, 'n', {
      platform: 'linux',
      now,
      fs: {
        open: failingClose,
        unlink: async () => {
          throw eacces();
        },
      },
    }).catch((caught: unknown) => caught);
    const info = join(paths.trashDir, 'info', 'n.trashinfo');
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toBe(
      `Could not prepare Trash ${paths.trashDir}: EIO; the account was not logged out and its directory was not moved; the Trash reservation ${info} could not be removed`,
    );
    expect(await exists(info)).toBe(true);
    expect(await exists(join(source, 'state'))).toBe(true);
  });

  it('keeps the move failure when commit cleanup also fails', async () => {
    const { paths, source } = await setup();
    const move = await prepareTrash(paths, source, 'n', {
      platform: 'linux',
      now,
      fs: {
        rename: async () => {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        },
        unlink: async () => {
          throw eacces();
        },
      },
    });
    const error = await move.commit().catch((caught: unknown) => caught);
    const info = join(paths.trashDir, 'info', 'n.trashinfo');
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).data.code).toBe('invalid_configuration');
    expect((error as UsageError).message).toBe(
      `Could not move ${source} to ${move.destination}; the directory was not moved; the Trash reservation ${info} could not be removed`,
    );
    expect(await exists(join(source, 'state'))).toBe(true);
    expect(await exists(info)).toBe(true);
  });

  it('keeps the cross-device failure when commit cleanup also fails', async () => {
    const { paths, source } = await setup();
    const move = await prepareTrash(paths, source, 'n', {
      platform: 'linux',
      now,
      fs: {
        rename: async () => {
          throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
        },
        unlink: async () => {
          throw eacces();
        },
      },
    });
    const info = join(paths.trashDir, 'info', 'n.trashinfo');
    await expect(move.commit()).rejects.toThrow(
      `is on another filesystem than ${source}; the directory was not moved; the Trash reservation ${info} could not be removed`,
    );
  });

  it('names the leftover trashinfo when a stale-entry skip cannot clean up', async () => {
    const { paths, source } = await setup();
    await mkdir(join(paths.trashDir, 'files', 'n'), { recursive: true });
    const error = await prepareTrash(paths, source, 'n', {
      platform: 'linux',
      now,
      fs: {
        unlink: async () => {
          throw eacces();
        },
      },
    }).catch((caught: unknown) => caught);
    const info = join(paths.trashDir, 'info', 'n.trashinfo');
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toBe(
      `Could not prepare Trash ${paths.trashDir}: EACCES; the account was not logged out and its directory was not moved; the Trash reservation ${info} could not be removed`,
    );
  });

  it('exposes the reservation path and keeps it when abort fails', async () => {
    const { paths, source } = await setup();
    const move = await prepareTrash(paths, source, 'n', {
      platform: 'linux',
      now,
      fs: {
        unlink: async () => {
          throw eacces();
        },
      },
    });
    expect(move.reservation).toBe(join(paths.trashDir, 'info', 'n.trashinfo'));
    await expect(move.abort()).rejects.toMatchObject({ code: 'EACCES' });
    expect(await exists(join(paths.trashDir, 'info', 'n.trashinfo'))).toBe(true);
  });
});

describe('macOS trash', () => {
  it('darwin keeps the macOS rename', async () => {
    const { paths, source } = await setup('darwin');
    const move = await prepareTrash(paths, source, 'usage-codex-x', { platform: 'darwin' });
    expect(move.destination).toBe(join(paths.trashDir, 'usage-codex-x'));
    await move.abort();
    expect(await exists(source)).toBe(true);
    await move.commit();
    expect(await exists(source)).toBe(false);
    expect(await exists(join(paths.trashDir, 'usage-codex-x', 'state'))).toBe(true);
    expect(await exists(join(paths.trashDir, 'info'))).toBe(false);
    expect(await exists(join(paths.trashDir, 'files'))).toBe(false);
    expect(move.reservation).toBeUndefined();
  });
});
