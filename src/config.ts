import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import {
  CONFIG_MIRROR_MARKER,
  DEFAULT_DEBOUNCE_SECONDS,
  DEFAULT_EXTENSIONS,
} from './constants.js';
import {
  isPathInside,
  isValidExtension,
  normalizeExtension,
  normalizeRelative,
} from './paths.js';
import type { Config } from './types.js';

/**
 * Parses and validates a configuration. A relative `destination` is
 * resolved against `baseDirectory` (the repository root).
 */
export function parseConfig(raw: string, baseDirectory: string): Config {
  const parsed = (YAML.parse(raw) ?? {}) as Partial<Config>;

  if (
    typeof parsed.destination !== 'string' ||
    !parsed.destination.trim()
  ) {
    throw new Error(
      'gsynchro.yml: "destination" is required',
    );
  }

  if (
    !Array.isArray(parsed.items) ||
    parsed.items.length === 0 ||
    parsed.items.some(
      (item) => typeof item !== 'string',
    )
  ) {
    throw new Error(
      'gsynchro.yml: "items" must be a non-empty string array',
    );
  }

  if (
    parsed.debounce !== undefined &&
    (
      typeof parsed.debounce !== 'number' ||
      !Number.isFinite(parsed.debounce) ||
      parsed.debounce < 0
    )
  ) {
    throw new Error(
      'gsynchro.yml: "debounce" must be >= 0',
    );
  }

  if (
    parsed.extensions !== undefined &&
    (
      !Array.isArray(parsed.extensions) ||
      parsed.extensions.length === 0 ||
      parsed.extensions.some(
        (item) => typeof item !== 'string' || !item.trim(),
      )
    )
  ) {
    throw new Error(
      'gsynchro.yml: "extensions" must be a non-empty string array',
    );
  }

  const extensions = (
    parsed.extensions ?? DEFAULT_EXTENSIONS
  ).map(normalizeExtension);

  const invalidExtension = extensions.find(
    (extension) => !isValidExtension(extension),
  );

  if (invalidExtension) {
    throw new Error(
      `gsynchro.yml: invalid "extensions" entry "${invalidExtension}" ` +
      '(expected a dot followed by letters/digits, e.g. ".md")',
    );
  }

  return {
    destination: path.resolve(baseDirectory, parsed.destination),
    debounce: parsed.debounce ?? DEFAULT_DEBOUNCE_SECONDS,
    items: parsed.items.map(normalizeRelative),
    extensions,
  };
}

export async function loadConfig(
  configFile: string,
  baseDirectory: string,
): Promise<Config> {
  return parseConfig(await readFile(configFile, 'utf8'), baseDirectory);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function renderConfigYaml(cfg: Config): string {
  const itemsYaml = cfg.items
    .map((item) => `  - ${yamlString(item)}`)
    .join('\n');

  const extensionsYaml = cfg.extensions
    .map((extension) => `  - ${yamlString(extension)}`)
    .join('\n');

  return (
    `${CONFIG_MIRROR_MARKER}\n` +
    '# This file is generated from .gsynchro/gsynchro.yml in the repository.\n' +
    '# The repository configuration is authoritative; edits here are replaced.\n' +
    '# Files matching these rules are synchronized; other Drive files remain only in Drive.\n' +
    '# Existing local directory or mount point for the other side of the sync.\n' +
    `destination: ${yamlString(cfg.destination)}\n` +
    '\n' +
    '# Seconds of inactivity before reconciling filesystem changes.\n' +
    `debounce: ${cfg.debounce}\n` +
    '\n' +
    '# File extensions eligible for synchronization (case-insensitive).\n' +
    'extensions:\n' +
    `${extensionsYaml}\n` +
    '\n' +
    '# Glob patterns relative to the project root. Combine with "extensions"\n' +
    '# above, e.g. "docs/**/*.*" to pick up every eligible extension under docs/.\n' +
    'items:\n' +
    `${itemsYaml}\n`
  );
}

export type DestinationCheck =
  | { ok: true; resolved: string }
  | { ok: false; error: string };

export async function validateDestinationCandidate(
  repoRoot: string,
  rawValue: string,
): Promise<DestinationCheck> {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return { ok: false, error: 'Destination path cannot be empty.' };
  }

  const resolved = path.resolve(repoRoot, trimmed);

  if (resolved === repoRoot) {
    return {
      ok: false,
      error: 'Destination cannot be the repository root.',
    };
  }

  if (
    isPathInside(repoRoot, resolved) ||
    isPathInside(resolved, repoRoot)
  ) {
    return {
      ok: false,
      error: 'Repository and destination cannot contain each other.',
    };
  }

  try {
    const info = await stat(resolved);

    if (!info.isDirectory()) {
      return { ok: false, error: `Not a directory: ${resolved}` };
    }
  } catch {
    return {
      ok: false,
      error:
        `Directory does not exist or is not accessible: ${resolved}\n` +
        '  gsynchro does not create the destination automatically — ' +
        'create or mount it first.',
    };
  }

  return { ok: true, resolved };
}

/**
 * Both roots must exist and be separate directories before anything
 * missing from them can be interpreted as a deletion.
 */
export async function validateRoots(
  repoRoot: string,
  driveRoot: string,
): Promise<void> {
  if (driveRoot === repoRoot) {
    throw new Error(
      'Destination cannot be the repository root',
    );
  }

  if (
    isPathInside(repoRoot, driveRoot) ||
    isPathInside(driveRoot, repoRoot)
  ) {
    throw new Error(
      'Repository and destination cannot contain each other',
    );
  }

  /*
   * Deliberately do NOT create the destination here.
   *
   * If Google Drive is unmounted, silently recreating the mount-point
   * as a normal local directory would be dangerous.
   */
  const repoStat = await stat(repoRoot);
  const driveStat = await stat(driveRoot);

  if (!repoStat.isDirectory()) {
    throw new Error(
      `Repository root is not a directory: ${repoRoot}`,
    );
  }

  if (!driveStat.isDirectory()) {
    throw new Error(
      `Destination is not a directory: ${driveRoot}`,
    );
  }
}
