import { describe, expect, it } from 'vitest';
import { appPaths } from '../src/paths.js';

const xdg = { XDG_CONFIG_HOME: '/x/c', XDG_DATA_HOME: '/x/d', XDG_CACHE_HOME: '/x/k' };

const darwinPaths = {
  homeDir: '/h',
  configDir: '/h/.config/usage',
  configFile: '/h/.config/usage/config.yaml',
  backupFile: '/h/.config/usage/config.yaml.bak',
  dataDir: '/h/.local/share/usage',
  managedRoot: '/h/.local/share/usage/accounts',
  binDir: '/h/.local/share/usage/bin',
  cacheDir: '/h/Library/Caches/usage',
  trashDir: '/h/.Trash',
};

const linuxDefaults = {
  homeDir: '/h',
  configDir: '/h/.config/usage',
  configFile: '/h/.config/usage/config.yaml',
  backupFile: '/h/.config/usage/config.yaml.bak',
  dataDir: '/h/.local/share/usage',
  managedRoot: '/h/.local/share/usage/accounts',
  binDir: '/h/.local/share/usage/bin',
  cacheDir: '/h/.cache/usage',
  trashDir: '/h/.local/share/Trash',
};

describe('appPaths', () => {
  it('darwin paths are unchanged', () => {
    expect(appPaths('/h', { platform: 'darwin', env: {} })).toEqual(darwinPaths);
  });

  it('darwin ignores XDG variables', () => {
    expect(appPaths('/h', { platform: 'darwin', env: xdg })).toEqual(darwinPaths);
  });

  it('linux defaults', () => {
    expect(appPaths('/h', { platform: 'linux', env: {} })).toEqual(linuxDefaults);
  });

  it('linux honors absolute XDG variables', () => {
    expect(appPaths('/h', { platform: 'linux', env: xdg })).toEqual({
      homeDir: '/h',
      configDir: '/x/c/usage',
      configFile: '/x/c/usage/config.yaml',
      backupFile: '/x/c/usage/config.yaml.bak',
      dataDir: '/x/d/usage',
      managedRoot: '/x/d/usage/accounts',
      binDir: '/x/d/usage/bin',
      cacheDir: '/x/k/usage',
      trashDir: '/x/d/Trash',
    });
  });

  it('linux ignores empty and relative XDG values', () => {
    expect(
      appPaths('/h', {
        platform: 'linux',
        env: { XDG_CONFIG_HOME: '', XDG_DATA_HOME: 'rel/d', XDG_CACHE_HOME: '~/k' },
      }),
    ).toEqual(linuxDefaults);
  });

  it("ignores the runner's XDG variables", () => {
    expect(process.env.XDG_DATA_HOME).toBeUndefined();
    expect(appPaths('/h').dataDir).toBe('/h/.local/share/usage');
  });
});
