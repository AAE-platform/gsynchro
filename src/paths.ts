import { access } from 'node:fs/promises';
import path from 'node:path';

import {
  CONFIG_DIR_NAME,
  CONFIG_FILENAME,
  EXCLUDED_DIRECTORIES,
  EXTENSION_PATTERN,
  SYNCHRONIZATION_NOTICE_FILENAME,
} from './constants.js';

export function normalizeRelative(filePath: string): string {
  return filePath
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '');
}

export function hasGlobMagic(segment: string): boolean {
  return /[*?[\]{}]/.test(segment);
}

export function folderOrPatternToItem(value: string): string {
  const normalized = normalizeRelative(
    value.trim().replace(/\/+$/, ''),
  );

  if (normalized === '.' || normalized.length === 0) {
    return '*.*';
  }

  /*
   * Keep explicit globs and filenames intact. A plain path is interpreted
   * as a folder because the setup question is intentionally folder-first.
   */
  if (hasGlobMagic(normalized) || path.extname(normalized)) {
    return normalized;
  }

  return `${normalized}/**/*.*`;
}

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);

  return (
    relative !== '' &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

export function normalizeExtension(rawExtension: string): string {
  const trimmed = rawExtension.trim().toLowerCase();

  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

export function isValidExtension(extension: string): boolean {
  return EXTENSION_PATTERN.test(extension);
}

export function isSynchronizationNotice(relativePath: string): boolean {
  return normalizeRelative(relativePath).toLowerCase() ===
    SYNCHRONIZATION_NOTICE_FILENAME.toLowerCase();
}

/** The destination-side configuration mirror, watched to restore it. */
export function isConfigMirrorPath(relativePath: string): boolean {
  return normalizeRelative(relativePath).toLowerCase() ===
    `${CONFIG_DIR_NAME}/${CONFIG_FILENAME}`;
}

export function hasExcludedSegment(relativePath: string): boolean {
  return normalizeRelative(relativePath)
    .split('/')
    .some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

export function isAllowedRelativePath(
  relativePath: string,
  extensions: ReadonlySet<string>,
): boolean {
  const normalized = normalizeRelative(relativePath);

  if (!normalized) {
    return false;
  }

  if (isSynchronizationNotice(normalized)) {
    return false;
  }

  if (hasExcludedSegment(normalized)) {
    return false;
  }

  return extensions.has(path.extname(normalized).toLowerCase());
}

/*
 * Chokidar needs to walk a directory before it can apply a file-level
 * filter. Do not let a root pattern such as `*.*` turn that into a recursive
 * watch of an entire checkout: it is deliberately root-only. This conservative
 * check keeps only directories which can still lead to at least one configured
 * item. A `**` remains intentionally recursive.
 */
export function directoryMayContainConfiguredItem(
  relativePath: string,
  items: readonly string[],
): boolean {
  const directory = normalizeRelative(relativePath);

  if (!directory) {
    return true;
  }

  const directorySegments = directory.split('/');

  return items.some((item) => {
    const patternSegments = normalizeRelative(item).split('/');
    const firstDynamicSegment = patternSegments.findIndex(hasGlobMagic);

    /* A literal filename does not make its own name a directory. */
    const staticSegments = firstDynamicSegment === -1
      ? patternSegments.slice(0, -1)
      : patternSegments.slice(0, firstDynamicSegment);

    const sharedLength = Math.min(
      directorySegments.length,
      staticSegments.length,
    );

    for (let index = 0; index < sharedLength; index += 1) {
      if (directorySegments[index] !== staticSegments[index]) {
        return false;
      }
    }

    /* We still need to walk through parents on the way to a static prefix. */
    if (directorySegments.length <= staticSegments.length) {
      return true;
    }

    const remainingPatternSegments = patternSegments.slice(
      staticSegments.length,
    );

    if (remainingPatternSegments.includes('**')) {
      return true;
    }

    /*
     * For a non-recursive glob with one child directory, allow only the
     * directory levels that the pattern itself names before the filename.
     */
    const directoryLevelsAfterStaticPrefix = Math.max(
      0,
      remainingPatternSegments.length - 1,
    );

    return directorySegments.length <=
      staticSegments.length + directoryLevelsAfterStaticPrefix;
  });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
