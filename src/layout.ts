import path from 'node:path';

import {
  CONFIG_DIR_NAME,
  CONFIG_FILENAME,
  MACHINE_ID_FILENAME,
  STATUS_FILENAME,
  SYNCHRONIZATION_NOTICE_FILENAME,
  TRASH_DIR_NAME,
} from './constants.js';
import type { Side, SyncContext } from './types.js';

/*
 * Both sides share the same layout: `<root>/.gsynchro/` holds configuration
 * (authoritative in the repository, a generated mirror on the destination)
 * and the side-local status; `<root>/.trash/` holds propagated deletions.
 */

export function configDir(root: string): string {
  return path.join(root, CONFIG_DIR_NAME);
}

export function configPath(root: string): string {
  return path.join(configDir(root), CONFIG_FILENAME);
}

export function statusPath(root: string): string {
  return path.join(configDir(root), STATUS_FILENAME);
}

export function machineIdPath(repoRoot: string): string {
  return path.join(configDir(repoRoot), MACHINE_ID_FILENAME);
}

export function configGitIgnorePath(repoRoot: string): string {
  return path.join(configDir(repoRoot), '.gitignore');
}

export function noticePath(driveRoot: string): string {
  return path.join(driveRoot, SYNCHRONIZATION_NOTICE_FILENAME);
}

export function trashRoot(root: string): string {
  return path.join(root, TRASH_DIR_NAME);
}

export function sideRoot(ctx: Pick<SyncContext, 'repoRoot' | 'driveRoot'>, side: Side): string {
  return side === 'repo' ? ctx.repoRoot : ctx.driveRoot;
}
