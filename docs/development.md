# Development guide

## Setup and fast feedback

Use macOS or Linux with Node.js 22 or newer:

```sh
npm ci
npm run build
node dist/cli.js --help
```

During implementation, run the narrowest relevant Vitest file first, then the
full gate before handoff:

```sh
npx vitest run test/cache.test.ts
npm run format
npm run lint
npm run typecheck
npm test
npm run coverage
npm run pack:check
```

`npm test`, coverage, and packaging rebuild `dist/`. Do not commit `dist/`,
`coverage/`, `node_modules/`, logs, or generated `.tgz` files.

## Test safety

Automated tests must not touch real provider state, credentials, Keychain or
keyring, status-line configuration, or quota endpoints. Follow existing patterns:

- `mkdtemp` plus `appPaths(tempHome)` for filesystem/config tests.
  `test/setup-env.ts` removes the runner's `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and
  `XDG_CACHE_HOME` so Linux runs stay in the temporary home; pass `{ platform, env }` to `appPaths` to test either
  platform's layout.
- `src/trash.ts` takes injected `platform`, `now`, and filesystem functions;
  trash tests use a temporary home and never the real Trash.
- Fake executable scripts for vendor version, login, logout, and Codex JSONL.
- Fake Claude executables that emit noninteractive JSON usage envelopes.
- Fixed `Date` values for cache freshness, reset parsing, and human output.
- Spawned inert Node children for cleanup tests; explicitly terminate any
  foreign control child created by a test.
- Pack into a temporary directory, install there, and execute the installed bin.

The high-value test files are:

| Change                                  | Start with                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| YAML schema, atomic writes, permissions | `test/config.test.ts`                                                          |
| Registration, collector, purge          | `test/accounts.test.ts`, `test/trash.test.ts`                                  |
| Platform paths (macOS, Linux XDG)       | `test/paths.test.ts`                                                           |
| Selection and sorting                   | `test/selectors.test.ts`                                                       |
| Freshness and timestamp races           | `test/cache.test.ts`                                                           |
| Process/signal cleanup                  | `test/processes.test.ts`                                                       |
| Codex protocol and retry                | `test/codex-flow.test.ts`, `test/providers.test.ts`                            |
| Claude noninteractive usage             | `test/claude-live.test.ts`, `test/providers.test.ts`                           |
| Fallback and exit codes                 | `test/collect.test.ts`                                                         |
| Directory inventory                     | `test/discovery.test.ts`, `test/discovery-cli.test.ts`, `test/collect.test.ts` |
| Human/JSON contracts                    | `test/render.test.ts`, `test/tui.test.ts`                                      |
| Tarball contents and installed bin      | `test/package.test.ts`                                                         |

Coverage is configured in `vitest.config.ts`. The branch threshold applies to
configuration, selectors, cache, process cleanup, and provider adapters; keep
each risk-bearing area at or above 80%, not merely the aggregate.

## Common change recipes

### Add or change configuration

Update `UsageConfig`/`AccountConfig`, allowed-field sets and validation in
`src/config.ts`, defaults when applicable, manual-YAML documentation, and config
tests. Decide whether old files need an in-memory compatibility inference. Keep
unknown-field rejection and atomic backup behavior intact.

### Change provider parsing

Add a sanitized fixture that contains only protocol/UI fields needed by the
parser. Preserve every active window and exact numeric percentage. Add explicit
tests for the old layout, new layout, malformed input, alternate screens,
timeout, and cleanup. Never log raw Claude capture to diagnose a layout; add
phase-only or allowlisted semantic diagnostics instead.

### Add a provider

Implement `ProviderAdapter`, extend normalized provider/account types and
selectors deliberately, wire it through `collectUsage`, then cover live/cache
semantics, concurrency, fallback, rendering, doctor, account lifecycle, docs,
and packaging. Do not leak provider-specific response objects into renderers.

### Change child-process behavior

Register ownership immediately after spawn. Cleanup must cover success, error,
timeout, SIGINT, and SIGTERM; try graceful exit, bound every wait, then escalate
only against the owned handle. Add a test proving an untracked process is never
touched.

### Change public output

Human output must remain useful without color. JSON changes must preserve one
valid document and `schemaVersion`; incompatible public changes require an
explicit schema decision. Keep warnings/diagnostics on stderr. Dashboard tests use fake terminal streams,
fake clocks, and stub collections to verify refresh scheduling and terminal
restoration without touching real accounts. Cover countdown-only row updates,
unchanged frames, shortened/removed rows, resize and short viewports, and warnings
printed after terminal restoration. Verify synchronized frame markers are paired
before waiting for collection or input and reset on failure and exit.

## Safe diagnostics

`--verbose` and `--debug-file` may report executable versions, selected labels,
safe state paths, phase/timing, retry/fallback decisions, cache age, and cleanup.
They must not include environment secrets, credential files, Keychain content,
raw authentication responses, prompts, model output, or full terminal captures.
Debug files are mode `0600`.

For Claude live issues, diagnose in this order:

1. `usage doctor` for version, login, collector, and cache.
2. `--verbose` for attempt, retry, fallback, and completion phases.
3. Fake or sanitized noninteractive JSON fixtures in tests.
4. A real-account smoke test only after the user explicitly approves it.

## Release checklist

1. Confirm versions and compatibility notes in README and architecture docs.
2. Run format check, lint, typecheck, tests, coverage, build, and pack dry-run.
3. Inspect the tarball list; only runtime output and documented package files
   should ship.
4. Install the packed artifact into a temporary prefix and run `usage --help`.
5. Confirm Git is clean and no provider or test child remains.
6. Tag/publish only when separately authorized. Never publish as a side effect
   of verification.

Discovery tests must supply a temporary home through `appPaths(tempHome)`. CLI tests
isolate the child process home and use cached/list commands or fake executables.
Cover matching names, directory additions/removals, explicit-registration precedence,
symlink deduplication, cache isolation when a directory changes, and logged-out rows
beside successful results. Never infer login by opening credential files.
`test/account-state.test.ts` covers missing registrations, cache resurrection,
deletion during version checks/retries or queued collection, and removed/retargeted
aliases. Fake vendors deliberately recreate absent state if launched; verify they
are skipped and successful sibling accounts remain visible.

Checkout-update changes are covered by `test/auto-update.test.ts`. Use temporary
local Git remotes and injected fake npm builds; never fetch, merge, or rebuild the
real checkout from automated tests. Other CLI tests pass `--no-update`. Cover
cancellation and drained process exit, close-time stderr reporting, dirty/divergent checkouts,
concurrent invocations, changes made during building, rollback, retry, and owned
process-group timeouts and SIGKILL escalation for stubborn descendants. Run the full verification sequence for updater changes.
