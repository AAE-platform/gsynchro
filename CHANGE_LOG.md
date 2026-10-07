# Change log

Newest first. Entries are added by `npm run release` from CURRENT_CHANGE.md.

## v0.3.4 — Transient synchronization progress

_2026-10-07_

Show transient terminal progress while scanning and applying a synchronization, including the current side and file path. The progress line is updated in place and is omitted from redirected output.

## v0.3.3 — Repository move and configurable file size

_2026-10-06_

Repository links now point to `AAE-platform/gsynchro` after the repository move. The npm package needs a new version publication for npm to receive the updated repository metadata. The configurable `maxFileSizeMiB` setting remains part of the current release work.

## v0.3.2 — Readme changed

_2026-10-06_

We add gsynchro to AAE-Platform

## v0.3.1 — Configurable maximum file size

_2026-10-06_

Configurable maximum synchronized file size: add `maxFileSizeMiB` to the YAML configuration and ask for it in the interactive setup wizard. The default remains 10 MiB.

## v0.3.0 — Clearer console log: renames and no echo events

_2026-10-04_

- A rename within the same folder is reported as `✍️ [side] file:<path> RENAMED old name: <name>` instead of a move between identical folders; a file moved and renamed at once shows both full paths.

- Echoes of gsynchro's own writes (a copy, a rename, a trashed file, a Markdown identity footprint) are no longer shown as `👀` events. They still trigger one confirming synchronization (`💤 nothing to do`), and remain visible with `--debug`.
- A blank line separates the end of a synchronization from the next events.

The README explains how to read the console log: raw events versus interpreted operations, echoes, delays, and an icon legend.

## v0.2.2 — Change log in reverse chronological order

_2026-10-04_

`CHANGE_LOG.md` now lists the newest release first; `npm run release` adds each new entry at the top.

## v0.2.1 — Aligned console output with millisecond timestamps

_2026-10-04_

Console lines now start with the time including milliseconds (`HH:MM:ss.fff`), shown fainter. A tab instead of two spaces separates the icon from the text, so the text lines up after every icon: terminals disagree on the width of icons such as ♻️ and ➡️, but not on where a tab goes.

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

## v0.1.36 and earlier

These versions predate this log; see the Git history and tags.
