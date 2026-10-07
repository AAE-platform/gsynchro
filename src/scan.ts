import fg from 'fast-glob';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { validateRoots } from './config.js';
import { ensureMarkdownIdentity, hashFile, isMarkdownPath } from './identity.js';
import { sideRoot } from './layout.js';
import { isAllowedRelativePath, normalizeRelative } from './paths.js';
import type {
  CollectResult,
  CandidateFile,
  CurrentState,
  DuplicateIdentity,
  FileSnapshot,
  Side,
  SkippedFile,
  StatusFile,
  SyncContext,
} from './types.js';

/*
 * Shared by the live scanner and the setup wizard's preview, so both
 * apply exactly the same matching and safety rules.
 */
export async function collectCandidates(
  root: string,
  items: string[],
  extensions: ReadonlySet<string>,
  maxFileSize: number,
): Promise<CollectResult> {
  /*
   * fast-glob does the configured path filtering.
   * The fixed safety rules below are applied independently.
   */
  const candidates = await fg(items, {
    cwd: root,
    onlyFiles: true,
    unique: true,
    dot: true,
    followSymbolicLinks: false,

    ignore: [
      '**/.git/**',
      '**/node_modules/**',
      '**/.gsynchro/**',
      '**/.trash/**',
    ],
  });

  const files: CandidateFile[] = [];
  const oversized: Array<{ relativePath: string; size: number }> = [];

  for (const candidate of candidates) {
    const relativePath = normalizeRelative(candidate);

    if (!isAllowedRelativePath(relativePath, extensions)) {
      continue;
    }

    const absolutePath = path.join(root, relativePath);

    let info;

    try {
      info = await lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }

      throw error;
    }

    if (!info.isFile() || info.isSymbolicLink()) {
      continue;
    }

    /*
     * Files outside the safety scope are invisible to the sync engine.
     * They are therefore not interpreted as deletions.
     */
    if (info.size > maxFileSize) {
      oversized.push({ relativePath, size: info.size });
      continue;
    }

    files.push({
      relativePath,
      absolutePath,
      size: info.size,
      mtimeMs: info.mtimeMs,
    });
  }

  return { files, oversized };
}

export async function scanSide(
  ctx: SyncContext,
  side: Side,
  preferredIdentities: ReadonlyMap<string, string> = new Map(),
  knownSnapshots: ReadonlyMap<string, FileSnapshot> = new Map(),
): Promise<{
  snapshots: Map<string, FileSnapshot>;
  skipped: SkippedFile[];
  duplicateIdentities: DuplicateIdentity[];
}> {
  const { files, oversized } = await collectCandidates(
    sideRoot(ctx, side),
    ctx.config.items,
    new Set(ctx.config.extensions),
    ctx.config.maxFileSizeMiB * 1024 * 1024,
  );

  const result = new Map<string, FileSnapshot>();
  const identities = new Map<string, string[]>();

  const recordIdentity = (identity: string | undefined, relativePath: string) => {
    if (identity) {
      const paths = identities.get(identity) ?? [];
      paths.push(relativePath);
      identities.set(identity, paths);
    }
  };

  for (const file of files) {
    ctx.log.progress(`   scanning [${side}] ${file.relativePath}`);

    /* Skip re-hashing when size and mtime match the last saved snapshot. */
    const known = knownSnapshots.get(file.relativePath);
    const canReuseKnownSnapshot = known &&
      known.size === file.size &&
      known.mtimeMs === file.mtimeMs &&
      (!isMarkdownPath(file.relativePath) || Boolean(known.identity));

    if (canReuseKnownSnapshot) {
      result.set(file.relativePath, known);
      recordIdentity(known.identity, file.relativePath);
      continue;
    }

    let registration: Awaited<ReturnType<typeof ensureMarkdownIdentity>>;
    let hash: string;

    try {
      registration = await ensureMarkdownIdentity(
        file,
        preferredIdentities.get(file.relativePath),
      );
      hash = await hashFile(file.absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        ctx.log.debug(`SCAN ${side} file removed during scan: ${file.relativePath}`);
        continue;
      }
      /* A read error is never evidence of absence: abort the whole scan. */
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to read ${side} file ${file.relativePath}: ${detail}`,
        { cause: error },
      );
    }

    result.set(file.relativePath, {
      hash,
      size: file.size,
      mtimeMs: file.mtimeMs,
      identity: registration.identity,
    });
    recordIdentity(registration.identity, file.relativePath);
  }

  return {
    snapshots: result,
    skipped: oversized.map((item) => ({ side, ...item })),
    duplicateIdentities: [...identities]
      .filter(([, paths]) => paths.length > 1)
      .map(([identity, paths]) => ({ side, identity, paths })),
  };
}

export function snapshotsFromStatus(
  status: StatusFile | undefined,
  side: Side,
): Map<string, FileSnapshot> {
  const snapshots = new Map<string, FileSnapshot>();
  if (!status) {
    return snapshots;
  }

  for (const [relativePath, entry] of Object.entries(status.files)) {
    const snapshot = side === 'repo' ? entry.repo : entry.drive;
    if (snapshot) {
      snapshots.set(relativePath, snapshot);
    }
  }

  return snapshots;
}

export async function scanCurrentState(
  ctx: SyncContext,
  knownStatus?: StatusFile,
): Promise<CurrentState> {
  /*
   * Validate both roots BEFORE interpreting any absence as a delete.
   */
  await validateRoots(ctx.repoRoot, ctx.driveRoot);

  const repoScan = await scanSide(
    ctx,
    'repo',
    new Map(),
    snapshotsFromStatus(knownStatus, 'repo'),
  );

  /* A Drive file at a path already registered in the repo reuses its ID. */
  const repoIdentities = new Map<string, string>();
  for (const [relativePath, snapshot] of repoScan.snapshots) {
    if (snapshot.identity) {
      repoIdentities.set(relativePath, snapshot.identity);
    }
  }

  const driveScan = await scanSide(
    ctx,
    'drive',
    repoIdentities,
    snapshotsFromStatus(knownStatus, 'drive'),
  );

  return {
    repo: repoScan.snapshots,
    drive: driveScan.snapshots,
    skipped: [...repoScan.skipped, ...driveScan.skipped],
    duplicateIdentities: [
      ...repoScan.duplicateIdentities,
      ...driveScan.duplicateIdentities,
    ],
  };
}
