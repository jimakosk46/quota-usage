# Repository guide for agents

This file applies to the entire repository. Read it before changing code, then read
[`README.md`](README.md), [`docs/architecture.md`](docs/architecture.md),
[`docs/development.md`](docs/development.md), and [`todo.md`](todo.md).

## Product boundary

`quota-usage` is a Node.js CLI for macOS and Linux that reports ChatGPT Codex and
Claude Code **subscription quota windows**. It is not an API billing, spend, token-cost, or
API rate-limit tool. The binary is `usage`; the package is `quota-usage`.

These invariants are settled:

- Do not add a daemon, resident service, threshold, or `check` command.
- Checkout auto-updates use a bounded asynchronous task owned by the foreground
  CLI. Cancel and drain it on close or signals. It must never block collection, overwrite a dirty or
  non-main checkout, or expose raw Git/npm output. Build before publishing, own
  and clean updater process groups, and report failures only after the UI closes.
- The foreground TUI defaults only on interactive terminals. Keep `--plain`,
  redirected output, and `--json` finite; dashboard refreshes must not overlap.
- Discover `~/.codex` and `~/.claude` as defaults, plus immediate
  `~/.codex-<label>` and `~/.claude-<label>` directories, without
  reading credentials or installing collectors. Keep detected logged-out accounts
  visible, prefer explicit registrations on label/path collisions, and never
  persist runtime discovery entries into registration YAML. Display directory
  names while preserving colon selector aliases. Only `default` can alias a
  default directory; `personal` must be an actual account label.
- Require existing state directories for both registered and discovered inventory,
  including `--no-discover` and cached mode. Preserve missing registrations in YAML,
  skip vendor launches/retries for removed directories, and drop deleted or changed
  discovered entries before returning collection results. Quota caches never define
  inventory. Validate discovered symlink entries as well as their canonical targets.
- High usage and reached limits never cause a failure exit code.
- Preserve successful account results when another account fails.
- Never read or expose credentials, OAuth tokens, API keys, Claude Keychain
  secrets, Linux keyring secrets, Codex `auth.json`, Claude `.credentials.json`,
  or raw Claude terminal captures.
- Let the official vendor CLIs own login, refresh, and logout.
- Track and clean up only processes started by this program. Never discover,
  attach to, or terminate unrelated provider processes.
- Do not access a real account, live quota endpoint, Keychain, keyring, or real
  Claude status-line setting in automated tests. A real-account smoke test requires
  explicit user permission. Update tests use temporary local Git remotes and fake
  builds; disable auto-update in unrelated CLI tests.

## Working conventions

- Runtime target: macOS and Linux, Node.js 22+, strict TypeScript, ESM. Keep
  platform differences in `appPaths` (XDG base directories on Linux; macOS
  ignores them), `src/trash.ts` (macOS `~/.Trash`, freedesktop.org home trash
  on Linux), and the Linux preflight order in `removeAccount` (`src/accounts.ts`).
  Purge never deletes the account state directory permanently. On Linux it
  reserves the trash entry before logout; if that preparation fails or the trash
  is on another filesystem, it stops before logout, and the account stays
  registered and logged in with its directory not moved. A failed logout releases
  the reservation; if that fails, the error names the leftover `.trashinfo` file.
- Direct dependency versions are exact. Keep runtime dependencies small and
  update `package-lock.json` with any dependency change.
- Use `UsageError` and the stable error codes in `src/types.ts`; public error
  details must be credential-safe.
- Keep provider-specific behavior behind `ProviderAdapter`. Normalize at the
  adapter boundary and keep rendering provider-neutral.
- Treat configuration as user-editable: reject unknown fields with YAML paths,
  validate the whole document, preserve comments when practical, and write
  atomically with the required permissions.
- Preserve the Claude default-state distinction. Unset default mode uses
  `~/.claude` plus sibling `~/.claude.json`; explicitly setting
  `CLAUDE_CONFIG_DIR=~/.claude` is a different isolated state.
- Keep `dist/`, `coverage/`, `node_modules/`, logs, and tarballs out of Git.
  `prepack` rebuilds `dist/`, and the package `files` allowlist ships it.

## Before handing off a change

Run the checks appropriate to the change. Before a release or broad provider,
configuration, process, cache, or packaging change, run the complete sequence:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run coverage
npm run build
npm pack --dry-run
```

Coverage must keep at least 80% branch coverage for configuration, selectors,
cache handling, process cleanup, and each provider adapter. Tests must use temp
directories, fake executables, and protocol fixtures.

Commit generated lockfile changes, but do not commit generated build or coverage
output. Keep commits focused and update the README, agent docs, and `todo.md` when
behavior, architecture, compatibility, or planned work changes.
