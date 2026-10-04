import path from 'node:path';

import { emojiText, label, paint, sideLabel } from './output.js';
import type { CurrentState, Logger, Side, SyncOperation } from './types.js';

export function printCompletedOperations(
  log: Logger,
  operations: SyncOperation[],
): void {
  for (const operation of operations) {
    if (operation.type === 'copy') {
      const action = operation.reason.includes('conflict')
        ? 'CONFLICT'
        : operation.reason.startsWith('new ')
          ? 'NEW'
          : 'CHANGED';
      const emoji = action === 'CONFLICT'
        ? '⚠️'
        : action === 'NEW'
          ? '▶️'
          : '📝';
      const message = emojiText(
        emoji,
        `[${sideLabel(operation.from)}] file:${operation.path} ${paint(action, 'bold')}`,
      );
      if (action === 'CONFLICT') {
        log.warn(message);
      } else {
        log.info(message);
      }
      continue;
    }

    if (operation.type === 'move') {
      const side = `[${sideLabel(operation.from)}]`;
      const previousDirectory = path.posix.dirname(operation.previousPath);
      const directory = path.posix.dirname(operation.path);
      const previousName = path.posix.basename(operation.previousPath);
      const name = path.posix.basename(operation.path);

      if (previousDirectory === directory) {
        log.info(emojiText(
          '✍️',
          `${side} file:${operation.path} ${paint('RENAMED', 'bold')} old name: ${previousName}`,
        ));
      } else if (previousName === name) {
        log.info(emojiText(
          '➡️',
          `${side} file:${name} ${paint('MOVED', 'bold')} ${previousDirectory} -> ${directory}`,
        ));
      } else {
        /* Moved and renamed at once: show both full paths. */
        log.info(emojiText(
          '➡️',
          `${side} file:${operation.path} ${paint('MOVED', 'bold')} from: ${operation.previousPath}`,
        ));
      }
      continue;
    }

    /* A deletion is reported on the side where it originated. */
    log.info(
      emojiText(
        '❎',
        `[${sideLabel(operation.side === 'repo' ? 'drive' : 'repo')}] ` +
        `file:${operation.path} ${paint('DELETED', 'bold')}`,
      ),
    );
  }
}

export function printFinalStateWarnings(
  log: Logger,
  current: CurrentState,
): void {
  for (const item of current.skipped) {
    log.warn(
      `${label('⏭️', 'Skipped', 'yellow')} ${sideLabel(item.side)} ${item.relativePath} ` +
      `(${(item.size / 1024 / 1024).toFixed(2)} MiB > 10 MiB)`,
    );
  }

  const duplicateGroups = new Map<
    string,
    { identity: string; paths: string[]; sides: Side[] }
  >();
  for (const duplicate of current.duplicateIdentities) {
    const paths = [...duplicate.paths].sort();
    const key = `${duplicate.identity}\u0000${paths.join('\u0000')}`;
    const group = duplicateGroups.get(key) ?? {
      identity: duplicate.identity,
      paths,
      sides: [],
    };
    group.sides.push(duplicate.side);
    duplicateGroups.set(key, group);
  }

  for (const duplicate of duplicateGroups.values()) {
    const sides = duplicate.sides.map(sideLabel).join(' and ');
    log.warn(
      `${label('⚠️', 'duplicate detected', 'yellow')} on ${sides} file id:${duplicate.identity.slice(0, 8)}\n` +
      duplicate.paths.map((relativePath) => `  - ${relativePath}`).join('\n'),
    );
  }
}
