import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_EXTENSIONS } from '../src/constants.js';
import { statusPath } from '../src/layout.js';
import { createLogger } from '../src/output.js';
import { pathExists } from '../src/paths.js';
import { loadStatusFile } from '../src/status.js';
import { synchronize } from '../src/sync.js';
import type { Config, Logger, Side, StatusFile, SyncContext, SyncResult } from '../src/types.js';

/*
 * The console output of every synchronization run by the tests is appended
 * to one file, as the CLI would print it (plain style, as when redirected).
 * `npm test` clears it first and runs test files one at a time, so the file
 * reads in order. GSYNCHRO_TEST_DEBUG=1 also records the --debug lines.
 */
export const CONSOLE_LOG_FILE = path.resolve('test-results', 'console.log');

let fileHeaderWritten = false;

function appendLog(text: string): void {
  mkdirSync(path.dirname(CONSOLE_LOG_FILE), { recursive: true });
  appendFileSync(CONSOLE_LOG_FILE, text);
}

/** A logger writing to CONSOLE_LOG_FILE under a header naming the test. */
export function createTestLogger(
  title: string,
  tmpBase: string,
  captured: string[] = [],
): Logger {
  if (!fileHeaderWritten) {
    fileHeaderWritten = true;
    const testFile = path.relative(process.cwd(), process.argv[1] ?? 'unknown');
    appendLog(`\n${'#'.repeat(78)}\n# ${testFile}\n${'#'.repeat(78)}\n`);
  }
  appendLog(`\n=== ${title} ===\n`);

  /* Temporary paths differ on every run; keep the log comparable. */
  const write = (line: string) => {
    const cleaned = line.replaceAll(tmpBase, '<tmp>');
    captured.push(cleaned);
    appendLog(`${cleaned}\n`);
  };

  return createLogger(
    { out: write, err: write },
    process.env.GSYNCHRO_TEST_DEBUG === '1',
  );
}

/**
 * A repository folder and a destination folder side by side in a fresh
 * temporary directory, plus a context to synchronize them.
 */
export interface Fixture {
  base: string;
  ctx: SyncContext;
  /** Console lines printed so far, without the HH:MM:ss.fff prefix. */
  output: string[];
  root(side: Side): string;
  write(side: Side, relativePath: string, content: string | Buffer): Promise<void>;
  read(side: Side, relativePath: string): Promise<string>;
  exists(side: Side, relativePath: string): Promise<boolean>;
  remove(side: Side, relativePath: string): Promise<void>;
  trash(side: Side): Promise<string[]>;
  status(side?: Side): Promise<StatusFile>;
  sync(): Promise<SyncResult>;
  cleanup(): Promise<void>;
}

export async function createFixture(
  title: string,
  overrides: Partial<Config> = {},
): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'gsynchro-test-'));
  const captured: string[] = [];
  const repoRoot = path.join(base, 'repo');
  const driveRoot = path.join(base, 'drive');
  await mkdir(repoRoot);
  await mkdir(driveRoot);

  const ctx: SyncContext = {
    repoRoot,
    driveRoot,
    config: {
      destination: driveRoot,
      debounce: 0,
      items: ['*.*', 'docs/**/*.*', 'tasks/**/*.*'],
      extensions: [...DEFAULT_EXTENSIONS],
      ...overrides,
    },
    machineId: 'test-machine',
    log: createTestLogger(title, base, captured),
  };

  const root = (side: Side) => (side === 'repo' ? repoRoot : driveRoot);
  const resolve = (side: Side, relativePath: string) => path.join(root(side), relativePath);

  return {
    base,
    ctx,
    get output() {
      return captured.map((line) => line.replace(/^\d{2}:\d{2}:\d{2}\.\d{3} /, ''));
    },
    root,
    async write(side, relativePath, content) {
      const file = resolve(side, relativePath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    },
    read: (side, relativePath) => readFile(resolve(side, relativePath), 'utf8'),
    exists: (side, relativePath) => pathExists(resolve(side, relativePath)),
    remove: (side, relativePath) => rm(resolve(side, relativePath)),
    async trash(side) {
      try {
        return await readdir(path.join(root(side), '.trash'));
      } catch {
        return [];
      }
    },
    status: (side = 'repo') => loadStatusFile(statusPath(root(side))),
    sync: () => synchronize(ctx),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

/** Markdown content without the gsynchro identity footprint. */
export function stripIdentity(content: string): string {
  return content.replace(/<!-- gsynchro:v1 [^>]*-->\r?\n/, '');
}

export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition not met within ${timeoutMs} ms`);
}
