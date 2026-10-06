import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';

import { FALLBACK_SCAN_INTERVAL_MS } from './constants.js';
import { isEchoEvent } from './echo.js';
import { sideRoot, statusPath } from './layout.js';
import { emojiText, sideLabel } from './output.js';
import {
  directoryMayContainConfiguredItem,
  hasExcludedSegment,
  isAllowedRelativePath,
  isConfigMirrorPath,
  normalizeRelative,
} from './paths.js';
import { collectCandidates, snapshotsFromStatus } from './scan.js';
import { loadStatusFile } from './status.js';
import { synchronize } from './sync.js';
import { SIDES, type FsEvent, type Side, type SyncContext, type SyncResult } from './types.js';

export interface SyncServiceOptions {
  /** Interval of the mtime/size fallback scan; 0 disables it. */
  fallbackScanIntervalMs?: number;
  /** Called after every reconciliation. */
  onSync?: (result: SyncResult) => void;
}

/**
 * Long-running synchronization: watches both sides, debounces events and
 * serializes reconciliations so that at most one runs at a time.
 */
export class SyncService {
  private eventQueue: FsEvent[] = [];
  private watchers: FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private fallbackScanTimer: ReturnType<typeof setInterval> | undefined;
  private fallbackScanRunning = false;
  private reconcilePending = false;
  private inFlight: Promise<SyncResult> | undefined;
  /* Raw events are classified one at a time, in arrival order. */
  private classification: Promise<void> = Promise.resolve();
  private stopped = false;
  /* A blank line separates a synchronization block from the next events. */
  private separateNextEvent = false;

  constructor(
    private readonly ctx: SyncContext,
    private readonly options: SyncServiceOptions = {},
  ) {}

  /**
   * Runs a reconciliation now with the queued events. If one is already
   * running, a follow-up is scheduled and the running one is awaited.
   */
  async reconcileNow(): Promise<SyncResult> {
    if (this.inFlight) {
      this.ctx.log.debug('RECONCILE deferred: reconciliation already running');
      this.reconcilePending = true;
      return this.inFlight;
    }

    const events = this.eventQueue;
    this.eventQueue = [];

    this.inFlight = synchronize(this.ctx, events);
    try {
      const result = await this.inFlight;
      this.separateNextEvent = true;
      this.options.onSync?.(result);
      return result;
    } finally {
      this.inFlight = undefined;

      if (this.reconcilePending && !this.stopped) {
        this.reconcilePending = false;
        this.scheduleReconcile();
      }
    }
  }

  start(): void {
    this.watchers = SIDES.map((side) => this.createWatcher(side));

    const interval = this.options.fallbackScanIntervalMs ?? FALLBACK_SCAN_INTERVAL_MS;
    if (interval > 0) {
      void this.queueUnobservedChanges();
      this.fallbackScanTimer = setInterval(() => {
        void this.queueUnobservedChanges();
      }, interval);
    }
  }

  /** Stops watching and waits for a running reconciliation to finish. */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.fallbackScanTimer) {
      clearInterval(this.fallbackScanTimer);
      this.fallbackScanTimer = undefined;
    }

    await Promise.all(this.watchers.map((watcher) => watcher.close()));
    this.watchers = [];
    await this.classification;
    await this.inFlight;
  }

  queueEvent(side: Side, type: string, filePath: string): void {
    if (this.stopped) {
      return;
    }

    const relativePath = normalizeRelative(filePath);

    /*
     * The watchers may observe directories too.
     * Fixed exclusions are applied immediately; the destination's
     * configuration mirror is watched so that it can be restored.
     */
    const isConfigMirror = side === 'drive' && isConfigMirrorPath(relativePath);

    if (!isConfigMirror && hasExcludedSegment(relativePath)) {
      this.ctx.log.debug(`QUEUE ${side.toUpperCase()} ignored: ${type} ${relativePath}`);
      return;
    }

    /* Fallback-scan findings are compared with the status already. */
    if (type === 'poll') {
      this.enqueue(side, type, relativePath);
      return;
    }

    this.classification = this.classification.then(
      () => this.enqueueEvent(side, type, relativePath),
    );
  }

  /*
   * An event observed during a synchronization may be that run's own
   * write: decide only once it has finished and saved the new state.
   *
   * An echo is not shown — it is an obvious consequence of the operation
   * just printed — but it still triggers a synchronization, whose
   * "nothing to do" confirms that both sides have converged.
   */
  private async enqueueEvent(side: Side, type: string, relativePath: string): Promise<void> {
    while (this.inFlight) {
      await this.inFlight;
    }

    if (this.stopped) {
      return;
    }

    const echo = await isEchoEvent(this.ctx, side, type, relativePath);
    if (echo) {
      this.ctx.log.debug(`ECHO ${side.toUpperCase()} not shown: ${type} ${relativePath} matches the saved state`);
    }

    this.enqueue(side, type, relativePath, echo);
  }

  private enqueue(side: Side, type: string, relativePath: string, echo = false): void {
    this.eventQueue.push({
      side,
      type,
      path: relativePath,
      timestamp: Date.now(),
    });

    if (!echo && type !== 'poll' && !type.endsWith('Dir')) {
      if (this.separateNextEvent) {
        this.separateNextEvent = false;
        this.ctx.log.info('');
      }
      this.ctx.log.info(
        emojiText('👀', `[${sideLabel(side)}] file:${relativePath} ${type.toUpperCase()}`),
      );
    }

    this.ctx.log.debug(
      `QUEUE ${side.toUpperCase()} ${type} ${relativePath}`,
      { pendingEvents: this.eventQueue.length },
    );
    this.scheduleReconcile();
  }

  private scheduleReconcile(): void {
    const seconds = this.ctx.config.debounce;
    this.ctx.log.debug(`DEBOUNCE ${this.debounceTimer ? 'reset' : 'scheduled'}`, { seconds });

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.ctx.log.debug('DEBOUNCE elapsed', { reconcileRunning: Boolean(this.inFlight) });
      void this.reconcileNow();
    }, seconds * 1000);
  }

  /*
   * Some mounts do not emit filesystem events. Compare paths, sizes and
   * mtimes with the saved status and queue anything that differs.
   */
  private async queueUnobservedChanges(): Promise<void> {
    if (this.fallbackScanRunning || this.inFlight || this.debounceTimer || this.stopped) {
      return;
    }

    this.fallbackScanRunning = true;

    try {
      const status = await loadStatusFile(statusPath(this.ctx.repoRoot));
      const extensions = new Set(this.ctx.config.extensions);

      for (const side of SIDES) {
        const { files } = await collectCandidates(
          sideRoot(this.ctx, side),
          this.ctx.config.items,
          extensions,
          this.ctx.config.maxFileSizeMiB * 1024 * 1024,
        );
        const current = new Map(files.map((file) => [file.relativePath, file]));
        const previous = snapshotsFromStatus(status, side);

        for (const [relativePath, file] of current) {
          const snapshot = previous.get(relativePath);
          if (!snapshot || snapshot.size !== file.size || snapshot.mtimeMs !== file.mtimeMs) {
            this.ctx.log.debug(`FALLBACK ${side.toUpperCase()} detected: ${relativePath}`);
            this.queueEvent(side, 'poll', relativePath);
          }
        }

        for (const relativePath of previous.keys()) {
          if (!current.has(relativePath)) {
            this.ctx.log.debug(`FALLBACK ${side.toUpperCase()} detected removal: ${relativePath}`);
            this.queueEvent(side, 'poll', relativePath);
          }
        }
      }
    } catch (error) {
      this.ctx.log.debug('FALLBACK scan failed', error);
    } finally {
      this.fallbackScanRunning = false;
    }
  }

  private createWatcher(side: Side): FSWatcher {
    const root = sideRoot(this.ctx, side);
    const { config, log } = this.ctx;
    const extensionSet = new Set(config.extensions);

    log.debug(`WATCH ${side.toUpperCase()} starting`, {
      root,
      usePolling: side === 'drive',
      interval: 1000,
      ignoreInitial: true,
      items: config.items,
      extensions: config.extensions,
    });

    const watcher = chokidar.watch('.', {
      cwd: root,
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      usePolling: side === 'drive',
      interval: 1000,

      /*
       * Useful especially with editors that write through
       * temporary files and with cloud-drive clients.
       */
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },

      // Chokidar 5 accepts paths, not globs. fast-glob applies config.items
      // during reconciliation; prune excluded and irrelevant directories here.
      ignored: (filePath, info) => {
        const relativePath = path.relative(root, path.resolve(root, filePath));
        const normalizedPath = normalizeRelative(relativePath);
        const isConfigMirror = side === 'drive' && isConfigMirrorPath(normalizedPath);
        const isConfigDirectory = side === 'drive' &&
          normalizedPath.toLowerCase() === '.gsynchro';
        const ignored = (!isConfigMirror && !isConfigDirectory && hasExcludedSegment(normalizedPath)) ||
          (!isConfigMirror && !isConfigDirectory && info?.isDirectory() === true &&
            !directoryMayContainConfiguredItem(normalizedPath, config.items)) ||
          (!isConfigMirror && info?.isFile() === true &&
            !isAllowedRelativePath(relativePath, extensionSet));
        if (ignored) {
          log.debug(`FILTER ${side.toUpperCase()} ignored: ${relativePath}`);
        }
        return ignored;
      },
    });

    watcher.on('all', (eventName, filePath) => {
      log.debug(`EVENT ${side.toUpperCase()} ${eventName} ${String(filePath)}`);
      switch (eventName) {
        case 'add':
        case 'change':
        case 'unlink':
        case 'addDir':
        case 'unlinkDir':
          this.queueEvent(side, eventName, String(filePath));
          break;
      }
    });

    watcher.on('raw', (eventName, filePath, details) => {
      log.debug(`RAW ${side.toUpperCase()} ${eventName} ${String(filePath)}`, details);
    });

    watcher.on('ready', () => {
      log.debug(`READY ${side.toUpperCase()} initial scan complete`);
    });

    watcher.on('error', (error) => {
      log.error(`[gsynchro] ${side} watcher error: ${String(error)}`);
    });

    return watcher;
  }
}
