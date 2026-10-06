export type Side = 'repo' | 'drive';

export const SIDES: readonly Side[] = ['repo', 'drive'];

export interface Config {
  /** Absolute path of the other side of the sync. */
  destination: string;
  /** Seconds of inactivity before reconciling. */
  debounce: number;
  /** Maximum synchronized file size in MiB. */
  maxFileSizeMiB: number;
  /** Glob patterns relative to the root of each side. */
  items: string[];
  /** Lower-case extensions including the leading dot. */
  extensions: string[];
}

export interface FileSnapshot {
  hash: string;
  size: number;
  mtimeMs: number;
  identity?: string;
}

export interface StatusEntry {
  /** Identity shared by the two copies when they agree. */
  identity?: string;
  commonHash: string | null;
  repo: FileSnapshot | null;
  drive: FileSnapshot | null;
}

export interface StatusFile {
  version: 1;
  machineId?: string;
  updatedAt?: string;
  history?: StatusHistoryEntry[];
  files: Record<string, StatusEntry>;
}

export interface StatusHistoryEntry {
  syncId: string;
  machineId: string;
  at: string;
  result: 'started' | 'up-to-date' | 'completed' | 'failed';
  triggerEvents?: Array<Pick<FsEvent, 'side' | 'type' | 'path'>>;
  operations?: SyncOperation[];
  error?: string;
}

export interface FsEvent {
  side: Side;
  type: string;
  path: string;
  timestamp: number;
}

export interface SkippedFile {
  side: Side;
  relativePath: string;
  size: number;
}

export interface DuplicateIdentity {
  side: Side;
  identity: string;
  paths: string[];
}

export interface CurrentState {
  repo: Map<string, FileSnapshot>;
  drive: Map<string, FileSnapshot>;
  skipped: SkippedFile[];
  duplicateIdentities: DuplicateIdentity[];
}

export type SyncOperation =
  | {
      type: 'copy';
      from: Side;
      to: Side;
      path: string;
      reason: string;
    }
  | {
      type: 'delete';
      side: Side;
      path: string;
      reason: string;
    }
  | {
      type: 'move';
      from: Side;
      to: Side;
      previousPath: string;
      path: string;
      reason: string;
    };

export interface CandidateFile {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

export interface CollectResult {
  files: CandidateFile[];
  oversized: Array<{ relativePath: string; size: number }>;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string, details?: unknown): void;
}

/** Everything a synchronization run needs; no module-level state. */
export interface SyncContext {
  repoRoot: string;
  driveRoot: string;
  config: Config;
  machineId: string;
  log: Logger;
}

export interface SyncResult {
  result: 'up-to-date' | 'completed' | 'failed';
  operations: SyncOperation[];
  error?: string;
}
