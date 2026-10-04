# Change log

Entries are appended by `npm run release` from CURRENT_CHANGE.md.

Versions up to v0.1.36 predate this log; see the Git history and tags.

## v0.2.0 — Modular sync engine, test suite and safer reconciliation

_2026-10-04_

The single `src/cli.ts` is split into focused modules (configuration, scanning, planning, execution, status, watcher service, setup wizard, CLI) that share an explicit `SyncContext` instead of module-level state. The engine can now run against any pair of folders, which makes it testable.

Added an automated test suite (`npm test`, Node's test runner via tsx): a decision table for the planner, unit tests for path filters, configuration and Markdown identities, integration tests that synchronize two temporary folders, and a watcher test. Each test run saves the complete console output of the synchronizations it performs to `test-results/console.log`.

Fixes:

- An unmounted destination (an empty mount-point directory) no longer looks like "every file deleted on Drive": after a first synchronization, gsynchro requires its `.gsynchro/` or `GSYNCHRO.md` markers on the destination and otherwise refuses to run.
- A synchronized file that grows beyond 10 MiB is no longer treated as deleted (which moved the other copy to trash), nor later overwritten by the stale copy.
- The repository status history now accumulates (up to 50 entries) instead of keeping only the last run.
- Moving a deleted file to trash across devices now completes instead of failing on every run.
- Ctrl+C waits for a running synchronization to finish (press again to force).
- A relative `destination` is resolved against the repository root; a `NaN` debounce is rejected.
- Console output: every line starts with the local time (`HH:MM:ss`); each synchronization prints a compact block (`♻️ syncing ...`, one line per operation, then `✅ N operations applied`, `💤 nothing to do` or `💥 sync failed`) without the "status updated" lines; moves use ➡️; colors use the picocolors library.
- New `--help` and `--version` options; unknown options are rejected.

Release tooling: `npm run release` now reads this file, appends it to `CHANGE_LOG.md`, bumps the version, commits all pending changes as `[published] vX.Y.Z <title>`, tags, pushes and publishes. `prepublishOnly` also runs the tests. Added `AGENTS.md` for coding agents.
