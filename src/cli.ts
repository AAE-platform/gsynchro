#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { loadConfig } from './config.js';
import { configPath } from './layout.js';
import { createConsoleLogger, label, paint, printBanner } from './output.js';
import { pathExists } from './paths.js';
import { SyncService } from './service.js';
import { runSetup } from './setup.js';
import { ensureMachineId } from './status.js';
import { prepareDestination } from './sync.js';
import type { SyncContext } from './types.js';

const USAGE = `Usage: gsynchro [options]

Run from the project root. Synchronizes the files selected in
.gsynchro/gsynchro.yml with the configured destination directory.

Options:
  --setup      Create or edit the configuration interactively
  --debug      Print watcher, filter and reconciliation details
  --no-color   Plain output (also honoured: NO_COLOR environment variable)
  -v, --version
  -h, --help`;

const KNOWN_OPTIONS = new Set([
  '--setup',
  '--debug',
  '--no-color',
  '--version',
  '-v',
  '--help',
  '-h',
]);

async function readVersion(): Promise<string> {
  const packageMetadata = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return packageMetadata.version;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !KNOWN_OPTIONS.has(arg));

  if (unknown.length > 0) {
    console.error(`gsynchro: unknown option ${unknown.join(', ')}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const version = await readVersion();

  if (args.includes('--version') || args.includes('-v')) {
    console.log(version);
    return;
  }

  const log = createConsoleLogger(args.includes('--debug'));
  log.info('');
  printBanner(log, version);

  const repoRoot = process.cwd();
  const configFile = configPath(repoRoot);

  if (args.includes('--setup') || !(await pathExists(configFile))) {
    if (!(await runSetup(repoRoot))) {
      return;
    }
  }

  const config = await loadConfig(configFile, repoRoot);
  const ctx: SyncContext = {
    repoRoot,
    driveRoot: config.destination,
    config,
    machineId: await ensureMachineId(repoRoot, log),
    log,
  };

  await prepareDestination(ctx);

  log.info(`  ${paint('Repo', 'bold')}:  ${ctx.repoRoot}`);
  log.info(`  ${paint('Drive', 'bold')}: ${ctx.driveRoot}`);
  log.info(`  ${paint('Debounce', 'bold')}:    ${config.debounce}s`);
  log.info(`  ${paint('Max file size', 'bold')}: ${config.maxFileSizeMiB} MiB`);
  log.info(`  ${paint('Extensions', 'bold')}:  ${config.extensions.join(' ')}`);
  log.info(`  ${paint('Conflicts', 'bold')}:   repo wins`);
  log.debug('Debug enabled; RAW events precede normalized EVENT and QUEUE logs');

  const service = new SyncService(ctx);

  /*
   * First reconciliation happens before watchers start.
   */
  await service.reconcileNow();
  service.start();

  log.info(`${label('👀', 'Watching', 'green')} repo and drive for changes`);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) {
      /* A second signal does not wait for a hung mount. */
      process.exit(1);
    }
    stopping = true;
    log.info(`\n${label('👋', 'Stopping', 'yellow')} ${signal} received; finishing current sync and closing watchers`);
    void service.stop().then(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main().catch((error) => {
  createConsoleLogger(false).error(
    `${label('💥', 'Fatal', 'red')}: ${error instanceof Error ? error.message : String(error)}`,
  );

  process.exit(1);
});
