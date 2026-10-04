import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CONFIG_GITIGNORE_ENTRIES, STATUS_HISTORY_LIMIT } from './constants.js';
import { configDir, configGitIgnorePath, machineIdPath } from './layout.js';
import type {
  CurrentState,
  Logger,
  Side,
  StatusEntry,
  StatusFile,
  StatusHistoryEntry,
} from './types.js';

export function emptyStatus(): StatusFile {
  return { version: 1, files: {} };
}

/**
 * A missing status is an empty baseline; a malformed one is an error, so
 * that missing files are never interpreted as deletions against garbage.
 */
export async function loadStatusFile(statusFile: string): Promise<StatusFile> {
  let raw: string;
  try {
    raw = await readFile(statusFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyStatus();
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as StatusFile;

  if (
    parsed.version !== 1 ||
    !parsed.files ||
    typeof parsed.files !== 'object'
  ) {
    throw new Error(
      `Unsupported or invalid status file: ${statusFile}`,
    );
  }

  return parsed;
}

/** Atomic write: temporary file, then rename. */
export async function saveStatusFile(
  statusFile: string,
  status: StatusFile,
): Promise<void> {
  await mkdir(path.dirname(statusFile), { recursive: true });
  const tmpPath = `${statusFile}.tmp-${process.pid}`;

  await writeFile(
    tmpPath,
    `${JSON.stringify(status, null, 2)}\n`,
    'utf8',
  );

  await rename(tmpPath, statusFile);
}

export function withStatusHistory(
  status: StatusFile,
  entry: StatusHistoryEntry,
  previousHistory: StatusHistoryEntry[] | undefined = status.history,
): StatusFile {
  return {
    ...status,
    machineId: entry.machineId,
    updatedAt: entry.at,
    history: [...(previousHistory ?? []), entry].slice(-STATUS_HISTORY_LIMIT),
  };
}

/**
 * The common state after a reconciliation. Paths skipped during the scan
 * keep their previous entry (if any), so that they are not later mistaken
 * for new or deleted files.
 */
export function buildStatusFromState(
  state: CurrentState,
  previousStatus?: StatusFile,
): StatusFile {
  const files: Record<string, StatusEntry> = {};
  const skippedPaths = new Set(state.skipped.map((item) => item.relativePath));

  const allPaths = new Set<string>([
    ...state.repo.keys(),
    ...state.drive.keys(),
  ]);

  for (const relativePath of skippedPaths) {
    const previous = previousStatus?.files[relativePath];
    if (previous) {
      files[relativePath] = previous;
    }
  }

  for (const relativePath of allPaths) {
    if (skippedPaths.has(relativePath)) {
      continue;
    }

    const repo = state.repo.get(relativePath) ?? null;
    const drive = state.drive.get(relativePath) ?? null;

    /*
     * After a successful reconciliation these should normally match.
     *
     * If they do not, commonHash remains null rather than pretending
     * that a common state exists.
     */
    const commonHash =
      repo && drive && repo.hash === drive.hash
        ? repo.hash
        : null;

    const identity = repo?.identity && drive?.identity
      ? repo.identity === drive.identity
        ? repo.identity
        : undefined
      : repo?.identity ?? drive?.identity;

    files[relativePath] = {
      ...(identity ? { identity } : {}),
      commonHash,
      repo,
      drive,
    };
  }

  return { version: 1, files };
}

/** The side-local view written next to that side's files. */
export function buildSideStatus(
  state: CurrentState,
  side: Side,
): StatusFile {
  const snapshots = side === 'repo' ? state.repo : state.drive;
  const files: Record<string, StatusEntry> = {};

  for (const [relativePath, snapshot] of snapshots) {
    files[relativePath] = {
      ...(snapshot.identity ? { identity: snapshot.identity } : {}),
      commonHash: snapshot.hash,
      repo: side === 'repo' ? snapshot : null,
      drive: side === 'drive' ? snapshot : null,
    };
  }

  return { version: 1, files };
}

export async function ensureConfigGitIgnore(
  repoRoot: string,
  log: Logger,
): Promise<void> {
  const gitignore = configGitIgnorePath(repoRoot);
  await mkdir(configDir(repoRoot), { recursive: true });

  let contents: string;
  try {
    contents = await readFile(gitignore, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    log.info(`[gsynchro] creating ${gitignore}`);
    await writeFile(gitignore, `${CONFIG_GITIGNORE_ENTRIES.join('\n')}\n`, 'utf8');
    return;
  }

  const existingEntries = new Set(contents.split(/\r?\n/).map((line) => line.trim()));
  const missingEntries = CONFIG_GITIGNORE_ENTRIES.filter(
    (entry) => !existingEntries.has(entry),
  );

  if (missingEntries.length > 0) {
    log.warn(
      `[gsynchro] warning: ${gitignore} exists but is missing ignore entr${missingEntries.length === 1 ? 'y' : 'ies'}: ${missingEntries.join(', ')}`,
    );
  }
}

export async function ensureMachineId(
  repoRoot: string,
  log: Logger,
): Promise<string> {
  await ensureConfigGitIgnore(repoRoot, log);
  const file = machineIdPath(repoRoot);

  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as {
      machine_id?: unknown;
    };
    if (typeof parsed.machine_id === 'string' && parsed.machine_id.length > 0) {
      return parsed.machine_id;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const machineId = randomUUID();
  log.info(`[gsynchro] creating ${file}`);
  await writeFile(
    file,
    `${JSON.stringify({ machine_id: machineId, created_at: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  return machineId;
}
