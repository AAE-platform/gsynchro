# AGENTS.md

Guidance for coding agents working on this repository.

## What gsynchro is

A Node.js (≥ 20) TypeScript CLI that keeps a **filtered** set of documentation and task files synchronized in both directions between a repository and a second local directory, usually a Google Drive folder mounted by Drive for desktop or rclone. It never talks to Google Drive and never synchronizes source code. User documentation is in [README.md](README.md); design notes are in [docs/](docs/).

## Commands

```bash
npm install
npm run typecheck   # tsc over src/ and test/
npm test            # node:test via tsx, test/**/*.test.ts
npm run build       # clean dist/ and compile src/
npm run gsynchro    # run the CLI from source in the current directory
```

Run `npm run typecheck` and `npm test` before considering a change done.

## Source layout

| Module | Responsibility |
| --- | --- |
| `src/cli.ts` | Entry point: options, setup, start of the service, signals |
| `src/types.ts` | Shared types, including `SyncContext` (roots, config, machine id, logger) |
| `src/constants.ts` | Limits, file names, defaults, excluded directories |
| `src/layout.ts` | Paths inside each root (`.gsynchro/`, status, trash, notice) |
| `src/paths.ts` | Pure path/glob/extension filters |
| `src/config.ts` | Parsing, validation and rendering of `.gsynchro/gsynchro.yml`; root validation |
| `src/notice.ts` | Destination `GSYNCHRO.md`, configuration mirror, unmounted-destination guard |
| `src/identity.ts` | SHA-256 hashing and the Markdown identity footprint |
| `src/scan.ts` | Candidate collection and per-side snapshots |
| `src/plan.ts` | **Pure** reconciliation planner (copy / delete / move) |
| `src/execute.ts` | Atomic copies and moves to `.trash/` |
| `src/status.ts` | Status files, history, machine id, `.gsynchro/.gitignore` |
| `src/sync.ts` | One complete reconciliation (`synchronize`) and startup checks |
| `src/service.ts` | `SyncService`: chokidar watchers, debounce, fallback scan, serialization |
| `src/echo.ts` | Recognizes watcher events caused by gsynchro's own writes |
| `src/setup.ts` | Interactive setup wizard |
| `src/report.ts` | Console reporting of operations and warnings |

There is no module-level mutable state: everything receives a `SyncContext`. Keep it that way so the engine stays testable.

## Tests

- `test/plan.test.ts`: decision table for `buildSyncPlan` and move detection.
- `test/units.test.ts`: path filters, configuration, Markdown footprint.
- `test/sync.test.ts`: integration tests. `createFixture()` in `test/helpers.ts` creates `repo/` and `drive/` in a temporary directory and runs `synchronize()` on them with a silent logger.
- `test/echo.test.ts`: echo recognition.
- `test/service.test.ts`: the watcher service end to end, including that echoes are not shown and lead to exactly one confirming synchronization.

`npm test` writes the full console output of every synchronization run by the tests to `test-results/console.log`, in order, with a header per test file and per test. Temporary paths appear as `<tmp>`. The test runner's report goes to `test-results/report.txt`. Set `GSYNCHRO_TEST_DEBUG=1` to include the `--debug` lines. The console output is part of the product: read this log when changing what gsynchro prints.

Every behaviour change or bug fix needs a test, preferably an integration test using the fixture. Do not mock the filesystem: the two-folder fixture is cheap and real.

## Safety invariants (do not weaken without an explicit decision)

1. The repository wins every conflict, including delete-versus-edit.
2. An absence is interpreted as a deletion only after both roots are validated and fully scanned. A read error aborts the run; it is never treated as a missing file.
3. Once files have been synchronized, a destination lacking both `.gsynchro/` and `GSYNCHRO.md` is treated as unmounted and the run is refused. Never create those markers while a run is failing.
4. Files outside the configured items/extensions, larger than 10 MiB, in excluded directories (`.git`, `node_modules`, `.gsynchro`, `.trash`), or symbolic links are invisible. They are never copied and never treated as deleted.
5. Propagated deletions go to the side's `.trash/`, never `rm`.
6. Copies go to a temporary file and are then renamed. Status files are written atomically and only after a verification rescan.
7. gsynchro never creates the destination directory.

## Change tracking and releases

- While developing, keep **`CURRENT_CHANGE.md`** up to date. It holds a `# Title` line and a description of the change in progress, written for users reading the change log. Update it whenever you change user-visible behaviour.
- Do **not** edit `CHANGE_LOG.md`, bump the version in `package.json`, create tags or publish. `npm run release -- [patch|minor|major]` does all of that. It is run by the maintainer.
- Do not commit or push unless asked.
- Update `README.md` (and `docs/linux-rclone.md` for Linux mount topics) when user-visible behaviour changes.

## Conventions

- ESM with `.js` extensions in relative imports (`NodeNext`), strict TypeScript.
- Dependencies are kept minimal (chokidar, fast-glob, yaml, picocolors). Ask before adding one.
- Code, comments and documentation are in English.
- The log intentionally shows raw watcher events (👀) next to the interpreted operations, with millisecond timestamps to measure delays. Do not merge or hide real events. Only echoes of gsynchro's own writes are not shown (`src/echo.ts`: the file already matches the saved status). They still trigger the confirming "nothing to do" synchronization and remain visible with `--debug`. The rationale is in README "Reading the console log".
- Console output goes through the `Logger` of the context, never `console.*` directly (except `--help`/`--version` and the interactive setup wizard). The logger prefixes every line with `HH:MM:ss.fff`; `emojiText()` puts a tab after the emoji so text lines up whatever width the terminal gives the emoji; colors come from `paint()` in `src/output.ts` (picocolors) and are off when output is not a TTY, with `NO_COLOR`, or with `--no-color`.
