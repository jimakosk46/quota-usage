# Architecture

This document is the shortest path from a fresh checkout to understanding where
a change belongs. User-facing behavior and commands are documented in the
[README](../README.md); implementation and verification procedures are in the
[development guide](development.md).

## Runtime flow

```text
src/cli.ts
  -> startAutoUpdate starts a bounded, CLI-owned checkout update task
  -> loadAccountConfig loads/validates optional config.yaml (in-memory defaults if absent)
  -> discoverAccounts merges immediate provider-prefixed home directories with registrations
  -> selectors choose registered accounts
  -> collectUsage coordinates mode, concurrency, fallback, and exit code
       -> CodexAdapter: fresh JSONL app-server child per account
       -> ClaudeLiveAdapter: owned noninteractive CLI child, sequentially
       -> cache: explicit cached mode and live-failure fallback
  -> foreground TUI repeats collection on interactive terminals (no overlapping checks)
  -> renderHuman or renderJson writes stdout for one-shot output
  -> ProcessTracker cleans every owned process on all exit paths
```

Diagnostics and warnings go to stderr. JSON mode emits exactly one versioned JSON
document to stdout and must never contain progress text or ANSI escapes.

## Module map

| Area           | Primary files                                               | Responsibility                                                                             |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| CLI wiring     | `src/cli.ts`                                                | Commander options and commands, output routing, signal cleanup                             |
| Public model   | `src/types.ts`, `src/errors.ts`                             | Normalized quotas, account/config types, stable error contract                             |
| Configuration  | `src/config.ts`, `src/paths.ts`                             | Strict YAML validation, atomic writes, permissions, canonical and platform paths           |
| Accounts       | `src/accounts.ts`, `src/trash.ts`                           | Registration, identity setup, Claude collector install/restore, removal/purge to Trash     |
| Discovery      | `src/discovery.ts`                                          | Directory inventory, explicit-registration precedence, directory-specific cache identities |
| Account state  | `src/account-state.ts`                                      | Read-only directory metadata and availability guards before provider launches and output   |
| Collection     | `src/collect.ts`, `src/selectors.ts`                        | Selection, concurrency, cache fallback, result sorting, exit aggregation                   |
| Process safety | `src/processes.ts`, `src/executable.ts`                     | Executable resolution, scrubbed vendor environments, owned-child lifecycle                 |
| Codex          | `src/providers/codex.ts`                                    | JSON-RPC handshake, identity verification, rate-limit normalization, retry boundary        |
| Claude cache   | `src/providers/claude-cache.ts`, `src/statusline-helper.ts` | Status-line extraction, chaining, atomic cache updates                                     |
| Claude live    | `src/providers/claude-live.ts`                              | Noninteractive `/usage` execution, JSON envelope and named-row parsing                     |
| Cache          | `src/cache.ts`                                              | Atomic newest-reading writes, freshness and expiration                                     |
| Presentation   | `src/render-human.ts`, `src/render-json.ts`, `src/tui.ts`   | Stable human and JSON contracts                                                            |
| Diagnostics    | `src/doctor.ts`, `src/uninstall.ts`                         | Read-only health checks and safe cleanup previews/actions                                  |

## Normalized data and errors

Adapters return `AccountResult` with exact provider percentages, derived remaining
percentages, zero or more windows, optional reset/duration/reached fields, plan,
credits, warnings, and a safe attached error. Do not assume only 5-hour and 7-day
windows. Credits are separate from quota percentages.

`collectUsage` owns fallback semantics:

- A successful live result replaces that account's newest cache.
- A failed live refresh may return a still-usable cached result plus the live
  error and `live refresh failed` warning.
- Expired cache is not usable.
- Exit `0` means every requested account is usable, `1` means partial failure,
  and `2` means no usable result. Usage level never affects the exit code.

Add public failure categories only by extending `ERROR_CODES`, documenting the
contract, and testing both JSON and exit-code behavior.

## Provider boundaries

### Codex

Each check starts a fresh absolute `codex app-server` with the registered
`CODEX_HOME`. It performs initialization, `account/read` without forced refresh,
identity-hash comparison, then `account/rateLimits/read`. Startup/transport
failures retry once; authentication, identity, version, timeout, and invalid
response failures do not. At most four Codex accounts run concurrently.

Never reuse or discover another app-server. Plan is display metadata; only the
normalized email hash is an identity boundary.

### Claude cached

Explicit account setup installs a compiled status-line wrapper. The helper keeps
only quota fields, collection time, source, and label; it atomically rejects an
older timestamp overwriting a newer reading. If a prior status-line command
existed, the exact input is chained to it and its visible output is preserved.

Collector restoration is compare-before-write: if the current setting drifted,
do not overwrite it. Return exact manual cleanup guidance instead.

### Claude live

Live mode is sequential. A fresh tracked child runs the absolute Claude executable
with `-p /usage`, JSON output, no tools, no session persistence, and safe mode.
The adapter parses only named current-session and current-week rows from the JSON
result. It retries one incomplete or failed response before cache fallback.

Claude's normal default state must launch with `CLAUDE_CONFIG_DIR` removed.
Isolated and managed accounts launch with their exact canonical directory. API
keys and explicit OAuth-token environment variables are removed in both cases.

## Local state and permissions

```text
~/.config/usage/config.yaml          0600
~/.config/usage/config.yaml.bak      0600
~/.local/share/usage/                directories 0700
~/.local/share/usage/accounts/       managed vendor state
~/.local/share/usage/bin/            compiled collector and owner-only backups
~/Library/Caches/usage/              cache files 0600 (macOS)
~/.cache/usage/                      cache files 0600 (Linux, default)
```

`appPaths` in `src/paths.ts` decides these locations. On Linux, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_CACHE_HOME` replace
`~/.config`, `~/.local/share`, and `~/.cache` when set to non-empty absolute
paths; macOS ignores them. Vendor state directories do not change.

Managed purge requires the exact expected path, no symlinks, a matching random
ownership marker, successful official logout, and a collision-safe move to the
Trash (`src/trash.ts`). macOS renames into `~/.Trash`. Linux follows the
freedesktop.org trash layout in `$XDG_DATA_HOME/Trash`: it creates
`info/<name>.trashinfo` exclusively before logout, refuses a trash on another
device before logout (the account stays registered and logged in and its
directory is not moved), releases the reservation if logout fails, then renames
into `files/<name>`. Unexpected filesystem errors during preparation report only
the errno code; any error other than `ENOENT` while checking for a stale
`files/<name>` also stops before logout. A failed cleanup never replaces the
primary error: if the reservation cannot be released after a failed preparation,
logout, or move, the error names the leftover `.trashinfo` file. External/default state is never purged, and the account state
directory is never deleted permanently.

## Packaging

TypeScript compiles to `dist/` with JavaScript, declarations, and source maps.
`dist/` is ignored by Git but is rebuilt by `prepack`; `package.json.files`
restricts the tarball to `dist/`, README, LICENSE, and package metadata. The
packed-artifact test installs the tarball with production dependencies and runs
its generated `usage` binary.

## Interactive presentation

The TUI is the default only when stdin and stdout are terminals. `--plain` and
`--json` remain finite snapshots; `--cached` also applies to dashboard refreshes.
`runTui` owns raw input, the alternate screen, scrolling, resize handling, and a
bounded refresh timer. It restores terminal state in `finally` and drains an
in-flight collection when quitting. Frames update only changed rows using absolute
cursor positions, overwrite text before erasing stale tails, and clear the screen
only on entry. Every frame is bracketed with synchronized-output mode 2026
markers in one write; no synchronization remains active while awaiting collection
or input, and cleanup always resets it. See the [protocol specification](https://github.com/contour-terminal/vt-extensions/blob/master/synchronized-output.md).
Resize invalidates row comparisons and redraws the clipped viewport;
frames never exceed its height. Warnings are deduplicated and printed after terminal
restoration so stderr does not scroll the dashboard. CLI verbose diagnostics are
also deferred while the dashboard is active, retaining the last 1,000 entries;
debug-file logging remains immediate. Existing process tracking owns provider cleanup.
Human window columns align across accounts. The human renderer excludes Codex
`codex_bengalfox:` windows before layout and color decisions, retaining them in
normalized results, caches, and JSON. Any reached visible window colors all quota rows for the same
account red without changing their usage or reached state. Reset countdowns always
precede absolute dates and remain emphasized while surrounding reset text is dimmed.
Seven-day windows also emphasize the localized weekday, including resets within a day;
intensity changes preserve reached-row colors. Reset-credit detail rows use the
normalized credit fields, sort dated entries first, show relative expiration before
the parenthesized local date with unpadded labels, omit the `available` status,
and emphasize only expirations
strictly within the next seven days. JSON and cache schemas remain unchanged.

## Directory inventory

`discoverAccounts` runs for each collection, list, and doctor invocation. It only
reads home directory entries, canonical paths, and filesystem metadata. It matches
`.codex-<label>` and `.claude-<label>` with the existing lowercase label grammar;
it also discovers `.codex` and `.claude` with the internal `default` label, preserving Claude default
launch mode. Defaults precede suffixed names; inferred label collisions receive an
available numbered suffix. Explicit labels and canonical
paths win, and aliases are deduplicated per provider.

Every matching directory is included before collection, regardless of login state.
The adapters report live authentication/usage failures, while cached mode performs
no vendor checks. Discovery errors do not discard explicit account results.
`--no-discover` limits the effective inventory to registered accounts.

Runtime `AccountConfig.discoveryKey` is a hash of the canonical path, device, inode,
and creation timestamp. It is not an allowed YAML field. It scopes discovered cache
filenames without altering the public result schema or credential handling. Explicit
registrations retain existing cache paths and identity pinning. Discovered entries
follow whatever subscription the official CLI currently has logged into that state
and never install a Claude collector or persist registrations. Removing a directory
removes its inferred row at the next scan; quota cache files are removed by uninstall.

Explicit registrations are filtered by directory availability too, even when
discovery is disabled. Missing paths, files, and broken symlinks are omitted from
the effective inventory without rewriting YAML or deleting caches. Inspection
failures produce safe configuration errors while preserving other account results.
Registered labels and paths still reserve their discovery precedence.
`account-state.ts` shares metadata checks between inventory, collection, doctor,
and provider adapters. Adapters check before account-specific launches and retries;
collection checks before cache use/write and filters results and account errors
against the final available inventory. A removed account cannot return through
cache fallback. Runtime `discoveryPath` preserves the original entry path, so a
removed/retargeted symlink or replaced canonical directory invalidates an in-flight
discovered account. Neither runtime discovery field is accepted in YAML. Filesystem
changes after the final check are reflected in the next collection.

Human headings and `accounts list` use directory names. Runtime
`AccountConfig.directoryName` preserves the discovered entry name even for a
symlink; explicit registrations use their state directory basename. Collection
attaches `directoryName` to public results for both live and cached output. JSON
retains `provider` and `label`; the display field is additive to schema version 1.
Selectors accept displayed directory names and existing colon aliases. The `default` alias falls back to a default directory if no actual account has
that label. `personal` is never an implicit alias. Bare provider selectors continue to select every account
for that provider.

## Background checkout updates

`src/auto-update.ts` starts an asynchronous task in the CLI process only for
quota commands run from a Git checkout. `--no-update` skips it. The installation
root comes from the module location. An AbortController cancels the task on close,
SIGINT, or SIGTERM. Shutdown waits for owned children and temporary-worktree
cleanup, then prints allowlisted diagnostics after terminal restoration. Results
stay in memory; no failures are deferred to future invocations. A completed
installation returns an explicit updated result and prints a success notice on
close; unchanged or skipped updates remain silent. Quota exit codes
and JSON remain unchanged. Git/npm children use separate process groups so their
descendants can be terminated together, but are never unreferenced. Cancellation
sends SIGTERM and escalates to SIGKILL after 300ms, awaiting child close. Worktree
cleanup has its own ten-second command timeout and is awaited even on cancellation.
Artifact publication or rollback already in progress finishes before shutdown.

`src/update-checkout.ts` uses a per-checkout lease in application state, a five-minute
command budget, and owned process groups for Git/npm descendants. It requires a
clean `main`, fetches `origin/main`, and builds the pinned target in a temporary
sibling worktree with locked development dependencies. It rechecks branch, HEAD,
and dirtiness before fast-forwarding and swapping the prepared dependency/build
directories. Failed publication rolls back runtime files; a pending marker forces
a rebuild retry even when HEAD already advanced. Recovery copies are retained if
the filesystem refuses rollback. Normal temporary worktrees and process groups are
cleaned on every exit path. Abandoned locks expire after fifteen minutes.

This finite maintenance task belongs to the foreground command and is drained
before normal shutdown. It never opens vendor credentials, contacts quota endpoints, stashes
changes, checks out another branch, or force-resets user work. Raw child output is
never printed or retained in update diagnostic state.
