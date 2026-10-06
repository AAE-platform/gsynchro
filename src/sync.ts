import { randomUUID } from 'node:crypto';

import { validateRoots } from './config.js';
import { executePlan } from './execute.js';
import { configDir, configPath, noticePath, statusPath } from './layout.js';
import {
  assertDestinationInitialized,
  writeConfigurationMirror,
  writeSynchronizationNotice,
} from './notice.js';
import { emojiText, formatElapsed, paint } from './output.js';
import { pathExists } from './paths.js';
import { buildSyncPlan } from './plan.js';
import { printCompletedOperations, printFinalStateWarnings } from './report.js';
import { scanCurrentState } from './scan.js';
import {
  buildSideStatus,
  buildStatusFromState,
  loadStatusFile,
  saveStatusFile,
  withStatusHistory,
} from './status.js';
import type {
  CurrentState,
  FsEvent,
  StatusFile,
  StatusHistoryEntry,
  SyncContext,
  SyncOperation,
  SyncResult,
} from './types.js';

/**
 * Startup checks and destination markers, before the first reconciliation:
 * validates both roots, refuses an apparently unmounted destination, then
 * writes the GSYNCHRO.md notice and the configuration mirror.
 */
export async function prepareDestination(ctx: SyncContext): Promise<void> {
  await validateRoots(ctx.repoRoot, ctx.driveRoot);
  await assertDestinationInitialized(
    ctx.driveRoot,
    await loadStatusFile(statusPath(ctx.repoRoot)),
  );

  if (await writeSynchronizationNotice(ctx.driveRoot, ctx.config)) {
    ctx.log.info(`[gsynchro] updated ${noticePath(ctx.driveRoot)}`);
  }

  if (await writeConfigurationMirror(ctx.driveRoot, ctx.config)) {
    ctx.log.info(`[gsynchro] updated ${configPath(ctx.driveRoot)}`);
  }
}

async function saveStatuses(
  ctx: SyncContext,
  state: CurrentState,
  previousRepoStatus: StatusFile,
  previousDriveStatus: StatusFile,
  entry: StatusHistoryEntry,
): Promise<void> {
  await saveStatusFile(
    statusPath(ctx.repoRoot),
    withStatusHistory(
      buildStatusFromState(state, previousRepoStatus),
      entry,
      previousRepoStatus.history,
    ),
  );

  await saveStatusFile(
    statusPath(ctx.driveRoot),
    withStatusHistory(buildSideStatus(state, 'drive'), entry, previousDriveStatus.history),
  );
}

/* Best effort: never let failure bookkeeping hide the original error. */
async function recordFailure(
  ctx: SyncContext,
  entry: StatusHistoryEntry,
): Promise<void> {
  try {
    const repoStatusFile = statusPath(ctx.repoRoot);
    await saveStatusFile(
      repoStatusFile,
      withStatusHistory(await loadStatusFile(repoStatusFile), entry),
    );
  } catch {
    /* Preserve the original synchronization error. */
  }

  try {
    /*
     * Do not create `.gsynchro/` in a destination that lacks it: on an
     * unmounted mount point that would fake the marker the guard checks.
     */
    if (await pathExists(configDir(ctx.driveRoot))) {
      const driveStatusFile = statusPath(ctx.driveRoot);
      await saveStatusFile(
        driveStatusFile,
        withStatusHistory(await loadStatusFile(driveStatusFile), entry),
      );
    }
  } catch {
    /* Preserve the original synchronization error. */
  }
}

/**
 * One complete reconciliation: scan both sides, plan, apply, verify by
 * rescanning, and only then persist the new common state. Never throws;
 * failures are logged, recorded in the status history and returned.
 */
export async function synchronize(
  ctx: SyncContext,
  events: FsEvent[] = [],
): Promise<SyncResult> {
  const { log } = ctx;
  const startedAt = process.hrtime.bigint();
  const historyContext = {
    syncId: randomUUID(),
    machineId: ctx.machineId,
    at: new Date().toISOString(),
    triggerEvents: events.map(({ side, type, path }) => ({ side, type, path })),
  };
  let plan: SyncOperation[] = [];

  log.info('');
  log.info(emojiText('♻️', paint('syncing ...', 'bold', 'cyan')));

  try {
    const previousStatus = await loadStatusFile(statusPath(ctx.repoRoot));

    await validateRoots(ctx.repoRoot, ctx.driveRoot);
    await assertDestinationInitialized(ctx.driveRoot, previousStatus);

    /* The repository configuration is authoritative for the Drive mirror. */
    await writeConfigurationMirror(ctx.driveRoot, ctx.config);

    const previousDriveStatus = await loadStatusFile(statusPath(ctx.driveRoot));

    /*
     * If this scan fails, no filesystem operation and no status write occur.
     */
    const before = await scanCurrentState(ctx, previousStatus);
    plan = buildSyncPlan(previousStatus, before);

    log.debug('RECONCILE scan result', {
      repoFiles: before.repo.size,
      driveFiles: before.drive.size,
      operations: plan,
    });

    if (plan.length === 0) {
      /*
       * Even without actions, refreshing the status is useful on first run.
       */
      await saveStatuses(ctx, before, previousStatus, previousDriveStatus, {
        ...historyContext,
        result: 'up-to-date',
      });

      printFinalStateWarnings(log, before, ctx.config.maxFileSizeMiB);
      log.info(emojiText('💤', `${paint('nothing to do', 'dim')} (${formatElapsed(startedAt)})`));

      return { result: 'up-to-date', operations: [] };
    }

    await executePlan(ctx, plan);

    /*
     * Verification scan.
     *
     * Do not trust the intended result: observe the filesystems again.
     */
    const after = await scanCurrentState(ctx, previousStatus);

    if (buildSyncPlan(buildStatusFromState(after), after).length !== 0) {
      throw new Error('Synchronization verification failed');
    }

    /*
     * Status is saved only after all filesystem operations succeeded
     * and both roots could be scanned again.
     */
    await saveStatuses(ctx, after, previousStatus, previousDriveStatus, {
      ...historyContext,
      at: new Date().toISOString(),
      result: 'completed',
      operations: plan,
    });

    printCompletedOperations(log, plan);
    printFinalStateWarnings(log, after, ctx.config.maxFileSizeMiB);
    const applied = `${plan.length} operation${plan.length === 1 ? '' : 's'} applied`;
    log.info(emojiText('✅', `${paint(applied, 'bold', 'green')} (${formatElapsed(startedAt)})`));

    return { result: 'completed', operations: plan };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    await recordFailure(ctx, {
      ...historyContext,
      at: new Date().toISOString(),
      result: 'failed',
      error: detail,
    });

    log.error(emojiText('💥', `${paint('sync failed', 'bold', 'red')} (${formatElapsed(startedAt)}): ${detail}`));

    return { result: 'failed', operations: plan, error: detail };
  }
}
