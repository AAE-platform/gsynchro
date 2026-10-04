import {
  access,
  copyFile,
  lstat,
  mkdir,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import { MAX_FILE_SIZE } from './constants.js';
import { hashFile, shortHash } from './identity.js';
import { sideRoot, trashRoot } from './layout.js';
import type { Side, SyncContext, SyncOperation } from './types.js';

export function formatTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

export async function copyBetweenSides(
  ctx: SyncContext,
  from: Side,
  to: Side,
  sourcePath: string,
  destinationPath = sourcePath,
): Promise<void> {
  const source = path.join(sideRoot(ctx, from), sourcePath);
  const destination = path.join(sideRoot(ctx, to), destinationPath);

  /*
   * Re-check the source immediately before copying.
   */
  const sourceInfo = await lstat(source);

  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(
      `Source is no longer a regular file: ${sourcePath}`,
    );
  }

  if (sourceInfo.size > MAX_FILE_SIZE) {
    throw new Error(
      `Source became larger than 10 MiB: ${sourcePath}`,
    );
  }

  await mkdir(path.dirname(destination), { recursive: true });

  /*
   * Copy to temporary file first, then atomically replace destination.
   */
  const temporary = `${destination}.gsynchro-tmp-${process.pid}`;

  await copyFile(source, temporary);
  await rename(temporary, destination);
}

export async function moveToTrash(
  ctx: SyncContext,
  side: Side,
  relativePath: string,
): Promise<void> {
  const root = sideRoot(ctx, side);
  const source = path.join(root, relativePath);

  try {
    await access(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }

  const snapshotHash = await hashFile(source);
  const extension = path.extname(relativePath);
  const basename = path.basename(relativePath, extension);
  const trash = trashRoot(root);

  await mkdir(trash, { recursive: true });

  const destination = path.join(
    trash,
    `${formatTimestamp()}-${basename}-${shortHash(snapshotHash)}${extension}`,
  );

  try {
    /*
     * rename() is cheap and atomic when source and trash are
     * on the same filesystem, which they normally are here.
     */
    await rename(source, destination);
  } catch (error) {
    /* A sub-folder may be a different mount: copy, then remove. */
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw error;
    }

    await copyFile(source, destination);
    await rm(source);
  }
}

export async function executePlan(
  ctx: SyncContext,
  operations: SyncOperation[],
): Promise<void> {
  for (const operation of operations) {
    switch (operation.type) {
      case 'copy':
        await copyBetweenSides(ctx, operation.from, operation.to, operation.path);
        break;

      case 'move':
        await copyBetweenSides(ctx, operation.from, operation.to, operation.path);
        await moveToTrash(ctx, operation.to, operation.previousPath);
        break;

      case 'delete':
        await moveToTrash(ctx, operation.side, operation.path);
        break;
    }
  }
}
