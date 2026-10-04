import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { renderConfigYaml } from './config.js';
import { configPath, sideRoot, statusPath } from './layout.js';
import { isConfigMirrorPath } from './paths.js';
import { snapshotsFromStatus } from './scan.js';
import { loadStatusFile } from './status.js';
import type { Side, SyncContext } from './types.js';

/**
 * Whether a watcher event only reflects what the last synchronization
 * already recorded — typically gsynchro observing its own writes (a copy,
 * a move, a trashed file, a Markdown identity footprint). Such an echo
 * carries no new information, so it is neither shown nor synchronized.
 *
 * The test is against the saved state, not a list of gsynchro's writes: an
 * event is an echo when the file on that side has the size and mtime saved
 * in the status (or is absent and not tracked there). Any doubt or error
 * answers false, so a real change is never dropped.
 */
export async function isEchoEvent(
  ctx: SyncContext,
  side: Side,
  type: string,
  relativePath: string,
): Promise<boolean> {
  try {
    if (side === 'drive' && isConfigMirrorPath(relativePath)) {
      const mirror = await readFile(configPath(ctx.driveRoot), 'utf8').catch(() => undefined);
      return mirror === renderConfigYaml(ctx.config);
    }

    const tracked = snapshotsFromStatus(
      await loadStatusFile(statusPath(ctx.repoRoot)),
      side,
    );

    if (type === 'addDir' || type === 'unlinkDir') {
      const prefix = `${relativePath}/`;
      const containsTrackedFile = [...tracked.keys()].some((file) => file.startsWith(prefix));
      return type === 'addDir' ? containsTrackedFile : !containsTrackedFile;
    }

    const known = tracked.get(relativePath);

    try {
      const info = await lstat(path.join(sideRoot(ctx, side), relativePath));
      return Boolean(
        known &&
        info.isFile() &&
        known.size === info.size &&
        known.mtimeMs === info.mtimeMs,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return !known;
      }
      throw error;
    }
  } catch {
    return false;
  }
}
