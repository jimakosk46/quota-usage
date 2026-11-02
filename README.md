# quota-usage

`quota-usage` is a command-line tool for macOS and Linux that reports ChatGPT Codex and Claude Code subscription quota windows across automatically detected and explicitly registered accounts. The executable is named `usage`.

It reports subscription allowance usage, reset times, plan metadata, and provider-supplied credits. It does **not** report API billing, API spend, token costs, or API rate limits. High usage and reached limits are information only; there are no thresholds and no `check` command.

## Requirements

- macOS on Apple Silicon or Intel, or Linux (see [Linux](#linux))
- Node.js 22 or newer
- The official `codex` and/or `claude` CLI for the providers you use
- Codex CLI 0.150.1 or newer
- Claude Code 2.1.238 or newer for multi-account setup and live collection

The Codex protocol was verified against Codex CLI 0.150.1. Claude cached and live behavior was verified against Claude Code 2.1.250; this project retains 2.1.238 as the safe minimum for multi-account operations.

## Install

After the package is published:

```sh
npm install --global quota-usage
usage --help
```

From a local checkout:

```sh
npm install
npm run build
npm link
usage --help
```

### Automatic updates from a checkout

When a quota command runs from a Git checkout (including an `npm link` install),
`usage` starts a one-shot background update from `origin/main`. It leaves the
current session running and uses the newer build on subsequent runs. Normal npm
package installations, help, and account-management commands do not self-update.
Use `usage --no-update` to skip this behavior.

The checkout must be on `main` with no staged, unstaged, or untracked changes.
Updates only fast-forward; they never stash edits, reset branches, or create merge
commits. A temporary sibling worktree installs locked dependencies with `npm ci`
and runs the build. Only a successful build is installed into the original
checkout. If installation fails, the previous runnable files are restored where
possible, and a pending build is retried on the next run.

Updates have a five-minute command budget and a per-checkout lock. Overlapping
invocations reuse the running job by skipping another update. Completed failures
are printed on stderr when the usage screen closes, without changing the quota
exit code or JSON stdout. Closing the CLI cancels unfinished updates, terminates owned Git/npm
process groups (escalating to SIGKILL after 300ms), and waits for child exit and
temporary-worktree cleanup. Updates cannot continue after normal CLI shutdown.
Startup and collection never wait for an update; shutdown waits only for
cancellation and cleanup, not for a build to finish. A short invocation may cancel
the update before it completes; a future invocation tries again. Failures and
cancellation are reported on that same close, never deferred to another run.
A successful installation prints `usage: CLI updated successfully; the new version
will be used on the next run.` on stderr after closing. An already-current checkout
or a skipped update stays quiet.

`--cached` still starts no provider process, but checkout updating remains enabled;
use `usage --cached --no-update` to avoid update network activity too.

The npm package ships compiled JavaScript, source maps, declarations, this README, and the license. TypeScript and a development runner are not needed after installation.

## Set up accounts

`usage` automatically discovers immediate home directories named `~/.codex-<label>/`
and `~/.claude-<label>/`. Usage headings match the directory names, such as `.codex-work` and
`.claude-personal`. The default directories appear simply as `.codex` and `.claude`. No registration file is required.
Every matching directory stays visible, including logged-out accounts: live
collection shows **auth failed** and a login-needed message when the provider
reports an authentication failure. Other failures retain their own error messages;
successful accounts remain visible.

Discovery scans directory names and metadata only, without reading credentials or
changing vendor settings. It runs for every collection (including dashboard
refreshes), `accounts list`, and `doctor`. Adding or removing a matching directory
updates the next inventory automatically. `accounts list` is a local inventory;
login and quota availability are checked during live collection. `--cached` scans
and reads caches only, so it cannot check current login state.

Explicit registrations are also shown and collected only while their state
directory exists, including with `--no-discover`. Deleting a directory leaves its
registration YAML and old quota cache untouched, but neither can bring the account
back into the dashboard or cause a vendor check to recreate its folder. Restoring
the directory makes the registration eligible again. Collection rechecks directories
before provider launches/retries and before returning results; deleted or replaced
discovered entries are dropped from that snapshot.

Suffixes use the same lowercase label rules below. Discovery is nonrecursive and
matches both the default and hyphenated names. Defaults use the internal selector label `default`;
if a separate suffixed directory also uses that label, it receives an available
numbered suffix such as `default-2`. Display names always remain the directory names. Directory symlinks are resolved and deduplicated; broken links
and files are ignored. Explicit registrations take precedence when either the
provider/label or the canonical state path overlaps. Use `--no-discover` to show
only explicit registrations.

Discovered accounts are external state and are never added to `config.yaml`.
Claude discovery preserves normal default mode for `~/.claude` and uses isolated
mode for suffixed directories. It does not install a status-line collector. Live collection populates a cache; explicit Claude registration remains
available if you want a collector. Discovered caches are tied to the canonical
directory and its filesystem identity, so replacing a directory or retargeting an
alias cannot reuse another directory's reading.

Explicit accounts are independent provider registrations. Labels are unique within a provider and use lowercase ASCII letters, digits, underscores, or hyphens. Uppercase labels are rejected.

Register the effective default vendor state directory:

```sh
usage accounts add codex personal --default
usage accounts add claude personal --default
```

`--default` resolves `CODEX_HOME` or `CLAUDE_CONFIG_DIR` at registration time, when set, and otherwise uses the vendor default. The canonical absolute path is saved. Later shell environment changes do not redirect it. Claude's unset default is preserved as a distinct launch mode because explicitly setting `CLAUDE_CONFIG_DIR=~/.claude` makes Claude use an isolated nested `.claude.json` rather than its normal sibling `~/.claude.json`.

Register an existing isolated state directory:

```sh
usage accounts add codex work --state-dir "$HOME/.codex-work"
usage accounts add claude work --state-dir "$HOME/.claude-work"
```

The path must exist, resolves through symlinks to its canonical location, and must be considered logged in by the official vendor CLI. Two labels for the same provider cannot use the same state directory.

Create new managed state and perform the official login once:

```sh
usage accounts add codex client --create
usage accounts add claude client --create
```

Managed state lives under `~/.local/share/usage/accounts/<provider>/<label>/` (on Linux, under `$XDG_DATA_HOME` when set; see [Local files](#local-files)). `usage` creates a random ownership marker, then launches the official vendor login under that exact state directory. Vendor CLIs continue to own credentials, refresh, and logout.

Claude setup previews its `settings.json` status-line change and asks for confirmation. It saves the prior setting in owner-only application state, installs a compiled collector under `~/.local/share/usage/bin/` (on Linux, `$XDG_DATA_HOME/usage/bin/` when `XDG_DATA_HOME` is set to an absolute path), and configures a label-specific wrapper. The status-line cache remains the fallback when live collection fails.

## Collect usage

```sh
usage
usage codex
usage claude
usage .codex
usage .codex-work .claude-personal
usage codex:personal
usage codex:personal claude:work
usage --cached
usage --plain
usage --tui --refresh 30s
usage --json
```

With no selector, every discovered and explicitly configured account is checked. A provider selector chooses every account for that provider. Multiple selectors are accepted and overlapping selections are deduplicated.
You can filter by displayed directory name, including an explicitly registered
arbitrary directory's basename. Existing `provider:label` selectors remain valid:
`codex:work` selects `.codex-work`, and `codex:default` selects `.codex`.
`personal` only selects an account actually labeled `personal`; it never aliases
a default directory. An existing explicit label takes precedence. Bare `codex` and `claude` continue to select all accounts
for that provider.

Modes:

- Default `usage`: open an auto-refreshing foreground dashboard on interactive terminals; print one snapshot when input or output is redirected. Each refresh collects Codex live and runs Claude's noninteractive `/usage` command, sequentially, for every selected Claude account.
- `usage --cached`: start no vendor process and perform no vendor version check. In the dashboard, reread caches at each refresh.
- `usage --plain`: print one aligned human-readable snapshot and exit.
- `usage --tui`: explicitly select the dashboard; requires interactive input and output.
- `usage --json`: print one JSON document and exit.

The dashboard refreshes one minute after each completed collection. Set `--refresh 30s` to change this interval (minimum one second). Press `r` to refresh, `q` to quit, or ↑/↓ (also `k`/`j`) to scroll. Refreshes never overlap. Countdown ticks redraw only changed rows; terminals supporting synchronized output display each frame together. Warnings and verbose diagnostics are printed after the dashboard closes (the last 1,000 verbose entries are retained; `--debug-file` records all entries as they occur). Quitting waits for the current collection to finish and restores the terminal. Narrow terminals clip long rows; widen the terminal to see full reset dates. The dashboard runs only while `usage` is open; it is not a background service.

Codex checks run with at most four accounts in parallel. Claude live checks run one at a time.

Global collection options:

```text
--cached
--no-update
--no-discover
--plain
--tui
--refresh <duration>
--json
--verbose
--debug-file <path>
--color <always|auto|never>
--codex-timeout <duration>
--claude-timeout <duration>
```

Durations accept values such as `10s`, `1m`, and `1.5m`. Defaults are 10 seconds for Codex and 30 seconds for Claude. Color defaults to interactive terminals only, and `NO_COLOR` always disables it.

## Output

Human output has a directory-name heading with a dimmed subscription name per account, one 20-character bar per active window, and shorter known durations first. Window labels, bars, percentages, and reset columns align across all accounts. Fractional blocks keep low values such as 3% visible without rounding them to a full 5% cell:

```text
.codex plus
  5h  [████▊░░░░░░░░░░░░░░░]   24% used  resets in 2h 14m, 18:40
  7d  [████████████▎░░░░░░░]   61% used  resets in 4d 3h, Mon, Aug 31 at 23:00

.claude-work max cached 4m ago
  5h  [████████████████▍░░░]   82% used  resets in 47m, 17:13
  7d  [███████▊░░░░░░░░░░░░]   39% used  resets in 3d 8h, Mon, Aug 31 at 04:00
```

Codex windows whose IDs start with `codex_bengalfox:` are hidden in human output (including the dashboard), but remain available in JSON. Hidden windows do not affect column widths or row colors.

Green is below 60% used, yellow is 60–79%, and red begins at 80%. `LIMIT REACHED` appears when the provider marks a window reached or usage reaches 100%, and the entire window row is red. When any visible limit is reached, all quota rows for the same account are red for both Codex and Claude; their percentages and own `LIMIT REACHED` markers remain unchanged. The marker follows the reset text directly, without padding to a separate column. Relative reset countdowns stand out; reset labels, absolute dates and times, and `reset unknown` are dimmed. Relative reset countdowns always appear before absolute dates and times. The 7d reset weekday is also highlighted and remains visible even when the reset is less than a day away. Stale data is yellow and expired or unavailable data is red. Output remains fully understandable without color. Unavailable accounts remain in sorted position and never get a fake zero bar.

Reset credits appear one per row, sorted by expiration date, with relative expiration first and the full local date and time in parentheses. Labels use a single space before expiration text, and the redundant `available` status is omitted. Rows are dimmed unless expiration is strictly less than seven days in the future. Expired credits remain labeled and dimmed; credits without expiration or with unknown dates follow dated credits. When only a count is supplied, it is shown without inventing expiration dates. Paid credit balances remain separate.

Every cached result shows age. A reading becomes stale after 15 minutes. If every reported reset time has passed, it is expired and unusable. A provider that omits reset time remains usable, becomes stale after 15 minutes, and displays `reset unknown`.

Warnings and verbose diagnostics go to standard error. Results go to standard output.

### JSON

`usage --json` writes exactly one valid JSON document to standard output, with no progress text, bars, or ANSI escapes:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-27T18:40:00.000Z",
  "mode": "default",
  "results": [
    {
      "provider": "codex",
      "label": "personal",
      "directoryName": ".codex",
      "plan": "plus",
      "source": "codex-app-server",
      "status": "live",
      "collectedAt": "2026-08-27T18:40:00.000Z",
      "windows": [
        {
          "id": "codex:primary",
          "usedPercent": 24.5,
          "remainingPercent": 75.5,
          "resetOriginal": 1787875200,
          "resetAt": "2026-08-27T21:20:00.000Z",
          "durationSeconds": 18000,
          "reached": false
        }
      ]
    }
  ],
  "errors": []
}
```

JSON retains `provider` and `label` for selector compatibility and adds `directoryName` for display. Provider percentages remain exact numeric values in JSON. Credits or paid extra usage are separate fields and are never combined with percentages.

Stable initial error codes are:

- `invalid_configuration`
- `missing_vendor_executable`
- `unsupported_vendor_version`
- `logged_out_account`
- `identity_mismatch`
- `timeout`
- `provider_failure`
- `parse_failure`
- `missing_cache`
- `expired_cache`

Errors include a safe human message, provider and account when applicable, and a `retryable` boolean. Raw terminal captures and credentials are never included. A usable cached fallback can appear in `results` beside the live error that caused it.

## Commands

```text
usage [selectors...] [collection options]
usage accounts add <provider> <label> --default
usage accounts add <provider> <label> --state-dir <path>
usage accounts add <provider> <label> --create
usage accounts list
usage accounts list --verbose
usage accounts remove <provider:label>
usage accounts remove <provider:label> --purge
usage accounts revalidate codex:<label>
usage doctor
usage uninstall
```

`accounts list` marks inferred entries as `auto-detected`. `accounts list --verbose` shows colon selector aliases, safe state paths and labels provider identity details as **unverified metadata**. There is no rename command in version 1; remove and register a new label instead.

`accounts revalidate` is Codex-only. It displays old and new masked, non-secret metadata, asks for confirmation, and records a new email hash. Plan changes alone never trigger an identity mismatch.

## Exit codes

- `0`: every requested account produced a usable result
- `1`: some requested accounts failed, including a live failure that used a cache fallback
- `2`: no usable result could be produced because of configuration or runtime failure

High percentages, reached limits, stale-but-usable readings, plans, and credits never change the exit code.

## How providers work

### Codex

Each live account check starts a fresh absolute `codex app-server --stdio` child with the registered `CODEX_HOME`, performs the documented initialization handshake, calls `account/read` with `refreshToken: false`, verifies the stored email hash, and calls `account/rateLimits/read`. Every active bucket and primary/secondary window is preserved; familiar 5-hour and 7-day windows are not hard-coded.

The app-server standard-input transport is process-local, so `usage` never discovers, attaches to, or reuses another app's server. The short-lived child receives EOF and is cleaned up after each check. Startup and transport failures retry once; authentication, identity, version, timeout, and invalid-response failures do not.

See the official [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server) and [Codex authentication documentation](https://learn.chatgpt.com/docs/auth).

### Claude cached collector

Claude Code's documented status-line JSON contains rolling subscription `rate_limits` after the first API response in a Claude Code CLI session. The installed helper receives that JSON on standard input, retains only quota windows, percentages, reset timestamps, label, source, and collection time, and atomically replaces the account's cache. Claude Desktop, browser sessions, and CLI sessions using another configuration directory do not update it. Concurrent sessions use a lock plus timestamp comparison so an older reading cannot overwrite a newer one.

If a previous status-line command existed, the helper passes the exact same input to it and prints its output. With no prior visible status line, the helper is quiet. It never retains prompts, responses, session content, unrelated token counts, or credentials.

See the official [Claude Code status-line documentation](https://code.claude.com/docs/en/statusline) and [environment variables](https://code.claude.com/docs/en/env-vars).

### Claude live collection

Default `usage` launches the absolute official Claude executable with `-p /usage`, JSON output, no tools, no session persistence, and safe mode. It applies the registered default or isolated configuration mode to every account. Noninteractive mode skips workspace trust and returns plain usage text inside a JSON envelope, so collection needs no PTY or terminal emulator.

The parser accepts only named current-session and current-week rows. Activity statistics and unrelated percentages cannot become quota windows. An incomplete or failed usage response retries once before the normal cache fallback. Claude itself performs the usage request. `usage` does not extract a token or call an undocumented endpoint.

## Credentials, privacy, and processes

`usage` never reads, copies, prints, or stores Codex `auth.json`, Claude `.credentials.json`, OAuth access or refresh tokens, API keys, setup tokens, Keychain secrets, or keyring secrets. On macOS it never invokes `security` or queries Keychain directly; on Linux it never queries a keyring or Secret Service directly. Official vendor CLIs own login, refresh, and logout.

Codex identity matching stores SHA-256 of a consistently normalized email, never the plaintext email. Normal output shows local labels. Claude identity is its local label bound to a canonical stable configuration directory.

The tool sends no telemetry or crash reports. Checkout auto-updates contact the configured Git origin and npm registry for updates and locked dependencies; `--no-update` disables them. `--verbose` and owner-only `--debug-file` output is deliberately redacted: it can contain versions, selected labels, safe paths, timing, cache decisions, retries, and cleanup actions, but no raw authentication data, environment secrets, terminal captures, prompts, or responses.

There is no daemon or resident service. Provider processes exist only during active collection, validation, login, logout, or doctor commands. Provider children created by `usage` are tracked and cleaned after success, failure, timeout, SIGINT, or SIGTERM. The checkout updater is owned by the foreground command; it cleans its Git/npm process groups after completion, failure, timeout, or cancellation and is drained before normal CLI shutdown. Processes not started by `usage` are never attached to or terminated.

## Local files

On macOS:

```text
Configuration:  ~/.config/usage/config.yaml
Backup:         ~/.config/usage/config.yaml.bak
Managed state:  ~/.local/share/usage/accounts/
Helper files:   ~/.local/share/usage/bin/
Cache:          ~/Library/Caches/usage/
Update state:   ~/.local/share/usage/updates/<checkout-hash>/
Purge Trash:    ~/.Trash/
```

On Linux, the XDG base directories apply. Each variable is used only when it is set
to a non-empty absolute path; otherwise its default is used. macOS ignores them.

```text
Configuration:  $XDG_CONFIG_HOME/usage/config.yaml
Backup:         $XDG_CONFIG_HOME/usage/config.yaml.bak
Managed state:  $XDG_DATA_HOME/usage/accounts/
Helper files:   $XDG_DATA_HOME/usage/bin/
Cache:          $XDG_CACHE_HOME/usage/
Update state:   $XDG_DATA_HOME/usage/updates/<checkout-hash>/
Purge Trash:    $XDG_DATA_HOME/Trash/

XDG_CONFIG_HOME defaults to ~/.config
XDG_DATA_HOME   defaults to ~/.local/share
XDG_CACHE_HOME  defaults to ~/.cache
```

Application directories use mode `0700`. Configuration, backup, ownership, collector-backup, and cache files use `0600`. YAML has top-level `schemaVersion: 1`, is completely validated before use, rejects unknown fields with their YAML path, and supports careful manual edits. Writes are atomic and retain one previous backup.

## Removal, purge, and uninstall

`accounts remove` acts on explicit registrations only. A matching directory is
still discovered after its registration is removed. Rename or move it outside the
matching pattern to stop discovering it, or use `--no-discover` for a command.
Logging out keeps the directory in the inventory with an authentication failure.

Normal removal restores a Claude status line only when the current setting still matches the wrapper installed by `usage`, removes registration and quota cache, and leaves vendor state and credentials untouched:

```sh
usage accounts remove claude:work
```

If the user changed Claude's setting afterward, `usage` does not overwrite it. It reports drift and prints the exact wrapper command to remove manually if still present.

`--purge` is only for verified managed state:

```sh
usage accounts remove codex:client --purge
```

It refuses default/external state, missing or mismatched ownership markers, symlinks, broad paths, and locations outside the managed root. After confirmation it asks the official vendor CLI to log out under the exact directory. If logout fails, state is not moved. A successful purge moves the directory to the Trash with a collision-safe name and reports that it is recoverable: `~/.Trash` on macOS, the freedesktop.org home trash on Linux (see [Linux](#linux)). It never deletes the directory permanently. There is no `--force`.

Prepare for npm removal with:

```sh
usage uninstall --preview
usage uninstall
npm uninstall --global quota-usage
```

`usage uninstall` previews its changes, safely restores matching Claude settings, removes helpers and caches, offers to remove configuration, and leaves all vendor state and logins untouched. Purge managed accounts separately first if desired. The npm uninstall lifecycle itself deletes no user data.

## Doctor and troubleshooting

`usage doctor` performs read-only checks for:

- YAML validity and schema version
- local file permissions and duplicate/unsafe paths
- vendor executable paths and versions
- vendor-reported login status for every account
- Codex app-server stdio capability
- Claude multi-account version support
- collector installation and configuration drift
- cache presence, age, expiration, and permissions
- managed ownership markers

It does not query live quota endpoints.

Common fixes:

- `missing_vendor_executable`: install the official CLI or set its absolute executable in `config.yaml`.
- `unsupported_vendor_version`: upgrade the official vendor CLI. Claude setup/live requires 2.1.238+.
- `logged_out_account`: run the official CLI using the account's registered state directory, or remove and re-register it.
- `identity_mismatch`: verify the intended Codex account, then run `usage accounts revalidate codex:<label>`.
- `missing_cache`: use Claude Code on that account after installing the collector, then retry.
- `expired_cache`: run normal `usage` to refresh live, or use Claude Code to refresh the status line.
- Collector drift: follow the exact manual cleanup instruction without overwriting the newer Claude setting.
- Claude live failure: retry with `--verbose`; a usable cache remains available when the noninteractive command fails.

## Linux

Linux uses the same commands, discovery rules, and vendor CLIs as macOS. Only local
paths, credential storage, and purge differ.

- Paths follow the XDG base directories listed in [Local files](#local-files).
  Vendor state directories (`~/.codex`, `~/.claude`, `CODEX_HOME`,
  `CLAUDE_CONFIG_DIR`) are unchanged.
- `usage` does not move its files when an XDG variable changes; set them before
  first use or set them back. With a different `XDG_CONFIG_HOME`, the configuration
  and its registrations are not found. Managed state stays at its old path and
  cannot be purged from the new one. A Claude collector keeps writing to its old
  cache until that account is removed and registered again.
- Claude Code keeps its credentials in `.credentials.json`
  under the state directory; Codex keeps them in `auth.json` there or in the
  system keyring, according to its own credential-store setting. `usage` never
  reads either.
- `--purge` moves managed state into the freedesktop.org home trash
  (`$XDG_DATA_HOME/Trash`). It reserves the `info/<name>.trashinfo` entry before
  asking the vendor CLI to log out, then moves the directory to `files/<name>`, so
  standard tools such as `gio trash --restore` can restore it. If the trash is on
  another filesystem than the account, or the trash entry cannot be prepared, purge
  stops before logout: the account stays registered and logged in, and its
  directory is not moved. A failed logout releases the reservation; if that fails,
  the error names the leftover `.trashinfo` file. If the final move fails, the
  directory stays where it was and the error says so, naming the leftover
  `.trashinfo` file if it could not be removed. The account state directory is
  never deleted permanently.

Tested on Ubuntu 24.04 x86_64 with Node.js 22.23.4, Claude Code 2.1.316, and Codex
CLI 0.166.0: discovery, `--plain`, `--json`, `--cached`, and `doctor`.
Not verified: other distributions, ARM64, Alpine/musl, and WSL2. WSL2 counts as
Linux when it runs the Linux builds of Node.js and the vendor CLIs.

## Development

New contributors and coding agents should start with [AGENTS.md](AGENTS.md), the
[architecture guide](docs/architecture.md), the
[development guide](docs/development.md), and the project [todo list](todo.md).

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run coverage
npm run build
npm pack --dry-run
```

Tests use temporary directories, protocol fixtures, fake vendor executables, and local Git remotes with fake builds. Unrelated CLI tests disable checkout updates. They do not touch real vendor state, credentials, Keychain or keyring, status-line settings, or live quota endpoints. CI runs the full check sequence on macOS and Ubuntu with Node.js 22 and 24.

Real-account verification is manual only. Do not run it without explicit permission. When authorized, smoke test with deliberately selected registrations by exercising default/cached/live/JSON output, running doctor, and removing any temporary registrations. Claude setup changes its status-line configuration after a confirmation, and live checks read current subscription state.

## Roadmap

- Quota history
- Loading animation
- More providers

## License

MIT © 2026 Floyd Haremsa
