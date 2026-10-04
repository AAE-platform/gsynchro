/*
 * Pure planning: from the last saved common state and the current scan of
 * both sides, decide which copy/delete/move operations reconcile them.
 * No filesystem access here — this is the part covered by unit tests.
 */

import type {
  CurrentState,
  FileSnapshot,
  Side,
  StatusEntry,
  StatusFile,
  SyncOperation,
} from './types.js';

export function snapshotsEqual(
  a: FileSnapshot | null | undefined,
  b: FileSnapshot | null | undefined,
): boolean {
  if (!a && !b) {
    return true;
  }

  if (!a || !b) {
    return false;
  }

  return a.hash === b.hash;
}

export function hashEqual(
  snapshot: FileSnapshot | null | undefined,
  hash: string | null,
): boolean {
  if (!snapshot && hash === null) {
    return true;
  }

  if (!snapshot || hash === null) {
    return false;
  }

  return snapshot.hash === hash;
}

/** identity → path, for identities that occur exactly once. */
export function uniqueIdentityPaths(
  snapshots: ReadonlyMap<string, FileSnapshot>,
): Map<string, string> {
  const paths = new Map<string, string>();
  const duplicates = new Set<string>();

  for (const [relativePath, snapshot] of snapshots) {
    if (!snapshot.identity) {
      continue;
    }

    if (paths.has(snapshot.identity)) {
      duplicates.add(snapshot.identity);
      continue;
    }

    paths.set(snapshot.identity, relativePath);
  }

  for (const identity of duplicates) {
    paths.delete(identity);
  }

  return paths;
}

function uniquePreviousIdentityPaths(
  status: StatusFile,
): Map<string, { path: string; entry: StatusEntry }> {
  const locations = new Map<string, { path: string; entry: StatusEntry }>();
  const duplicates = new Set<string>();

  for (const [relativePath, entry] of Object.entries(status.files)) {
    const identity = entry.identity ?? entry.repo?.identity ?? entry.drive?.identity;
    if (!identity || !entry.repo || !entry.drive) {
      continue;
    }

    if (locations.has(identity)) {
      duplicates.add(identity);
      continue;
    }

    locations.set(identity, { path: relativePath, entry });
  }

  for (const identity of duplicates) {
    locations.delete(identity);
  }

  return locations;
}

/*
 * A move is propagated only when the saved status confirms the file was
 * shared at one path, one side now has the same identity at a new path, and
 * the other side still holds the unchanged copy at the original path.
 */
export function detectMoves(
  previousStatus: StatusFile,
  current: CurrentState,
): { operations: SyncOperation[]; handledPaths: Set<string> } {
  const operations: SyncOperation[] = [];
  const handledPaths = new Set<string>();
  const previousLocations = uniquePreviousIdentityPaths(previousStatus);
  const repoPaths = uniqueIdentityPaths(current.repo);
  const drivePaths = uniqueIdentityPaths(current.drive);

  for (const [identity, previous] of previousLocations) {
    const repoPath = repoPaths.get(identity);
    const drivePath = drivePaths.get(identity);

    if (!repoPath || !drivePath || repoPath === drivePath) {
      continue;
    }

    const previousHash = previous.entry.commonHash;
    const repoMoved =
      repoPath !== previous.path &&
      drivePath === previous.path &&
      !current.drive.has(repoPath) &&
      hashEqual(current.drive.get(drivePath), previousHash);
    const driveMoved =
      drivePath !== previous.path &&
      repoPath === previous.path &&
      !current.repo.has(drivePath) &&
      hashEqual(current.repo.get(repoPath), previousHash);

    if (!repoMoved && !driveMoved) {
      continue;
    }

    const from: Side = repoMoved ? 'repo' : 'drive';
    const to: Side = repoMoved ? 'drive' : 'repo';
    const newPath = repoMoved ? repoPath : drivePath;

    operations.push({
      type: 'move',
      from,
      to,
      previousPath: previous.path,
      path: newPath,
      reason: `moved on ${from}`,
    });
    handledPaths.add(previous.path);
    handledPaths.add(newPath);
  }

  return { operations, handledPaths };
}

export function buildSyncPlan(
  previousStatus: StatusFile,
  current: CurrentState,
): SyncOperation[] {
  const { operations, handledPaths } = detectMoves(previousStatus, current);

  /*
   * A file skipped on either side (e.g. grown beyond the size limit) is
   * neither copied nor treated as deleted; its saved entry is kept as is.
   */
  for (const skipped of current.skipped) {
    handledPaths.add(skipped.relativePath);
  }

  const allPaths = new Set<string>([
    ...Object.keys(previousStatus.files),
    ...current.repo.keys(),
    ...current.drive.keys(),
  ]);

  for (const relativePath of allPaths) {
    if (handledPaths.has(relativePath)) {
      continue;
    }

    const previous = previousStatus.files[relativePath];
    const repo = current.repo.get(relativePath) ?? null;
    const drive = current.drive.get(relativePath) ?? null;

    /*
     * Already equal (including both absent).
     */
    if (snapshotsEqual(repo, drive)) {
      continue;
    }

    /*
     * No previous state:
     *
     * - only repo   -> repo wins/copy to Drive
     * - only Drive  -> import into repo
     * - both differ -> repo wins
     */
    if (!previous) {
      if (repo && !drive) {
        operations.push({
          type: 'copy',
          from: 'repo',
          to: 'drive',
          path: relativePath,
          reason: 'new on repository',
        });
      } else if (!repo && drive) {
        operations.push({
          type: 'copy',
          from: 'drive',
          to: 'repo',
          path: relativePath,
          reason: 'new on Drive',
        });
      } else if (repo && drive) {
        operations.push({
          type: 'copy',
          from: 'repo',
          to: 'drive',
          path: relativePath,
          reason: 'initial conflict, repository wins',
        });
      }

      continue;
    }

    const repoChanged = !hashEqual(repo, previous.commonHash);
    const driveChanged = !hashEqual(drive, previous.commonHash);

    /*
     * Only Drive changed.
     */
    if (!repoChanged && driveChanged) {
      operations.push(drive
        ? {
            type: 'copy',
            from: 'drive',
            to: 'repo',
            path: relativePath,
            reason: 'changed on Drive',
          }
        : {
            type: 'delete',
            side: 'repo',
            path: relativePath,
            reason: 'deleted on Drive',
          });

      continue;
    }

    /*
     * Only repository changed.
     */
    if (repoChanged && !driveChanged) {
      operations.push(repo
        ? {
            type: 'copy',
            from: 'repo',
            to: 'drive',
            path: relativePath,
            reason: 'changed on repository',
          }
        : {
            type: 'delete',
            side: 'drive',
            path: relativePath,
            reason: 'deleted on repository',
          });

      continue;
    }

    /*
     * Both sides changed.
     *
     * Repository always wins.
     */
    if (repo) {
      operations.push({
        type: 'copy',
        from: 'repo',
        to: 'drive',
        path: relativePath,
        reason: 'conflict, repository wins',
      });
    } else if (drive) {
      operations.push({
        type: 'delete',
        side: 'drive',
        path: relativePath,
        reason: 'delete/modify conflict, repository deletion wins',
      });
    }
  }

  return operations;
}
