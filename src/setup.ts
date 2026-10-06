import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface, type Interface } from 'node:readline/promises';

import {
  loadConfig,
  renderConfigYaml,
  validateDestinationCandidate,
} from './config.js';
import {
  DEFAULT_DEBOUNCE_SECONDS,
  DEFAULT_EXTENSIONS,
  DEFAULT_ITEM_SOURCES,
  DEFAULT_MAX_FILE_SIZE_MIB,
  PREVIEW_SAMPLE_SIZE,
  PREVIEW_WARN_FILE_COUNT,
  PREVIEW_WARN_TOTAL_BYTES,
  type DefaultItemSource,
} from './constants.js';
import { configDir, configPath, noticePath } from './layout.js';
import { writeConfigurationMirror, writeSynchronizationNotice } from './notice.js';
import { formatSize } from './output.js';
import {
  folderOrPatternToItem,
  isValidExtension,
  normalizeExtension,
  pathExists,
} from './paths.js';
import { collectCandidates } from './scan.js';
import type { CandidateFile, Config } from './types.js';

export async function discoverDefaultItemSources(
  repoRoot: string,
): Promise<DefaultItemSource[]> {
  const discovered: DefaultItemSource[] = [DEFAULT_ITEM_SOURCES[0]];

  for (const source of DEFAULT_ITEM_SOURCES.slice(1)) {
    if (!source.directory) {
      continue;
    }

    try {
      if ((await lstat(path.join(repoRoot, source.directory))).isDirectory()) {
        discovered.push(source);
      }
    } catch {
      /* A missing or inaccessible candidate is simply not proposed. */
    }
  }

  return discovered;
}

async function promptYesNo(
  rl: Interface,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  const suffix = defaultYes ? 'Y/n' : 'y/N';
  const answer = (
    await rl.question(`${question} [${suffix}] `)
  ).trim().toLowerCase();

  if (!answer) {
    return defaultYes;
  }

  return answer === 'y' || answer === 'yes';
}

function sumSize(files: CandidateFile[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

function printPreviewSample(files: CandidateFile[]): void {
  const sample = files.slice(0, PREVIEW_SAMPLE_SIZE);

  for (const file of sample) {
    console.log(`    ${file.relativePath} (${formatSize(file.size)})`);
  }

  if (files.length > sample.length) {
    console.log(`    ... and ${files.length - sample.length} more`);
  }
}

/**
 * Scans both roots with the candidate glob patterns using the exact same
 * matching rules as the live sync engine, and reports what a first sync
 * would bring into the repository, before anything is written or copied.
 *
 * Returns whether the user wants to proceed with these patterns.
 */
async function previewSelection(
  repoRoot: string,
  destination: string,
  items: string[],
  extensions: string[],
  maxFileSizeMiB: number,
  rl: Interface,
): Promise<boolean> {
  console.log('\n  Scanning matched files (preview only, nothing is copied)...');

  const extensionSet = new Set(extensions);

  const [repoResult, driveResult] = await Promise.all([
    collectCandidates(repoRoot, items, extensionSet, maxFileSizeMiB * 1024 * 1024),
    collectCandidates(destination, items, extensionSet, maxFileSizeMiB * 1024 * 1024),
  ]);

  const repoFiles = repoResult.files;
  const driveFiles = driveResult.files;

  const repoPaths = new Set(repoFiles.map((file) => file.relativePath));
  const driveOnly = driveFiles.filter(
    (file) => !repoPaths.has(file.relativePath),
  );
  const driveOnlySize = sumSize(driveOnly);

  console.log(
    `  repository:  ${repoFiles.length} file(s) matched (${formatSize(sumSize(repoFiles))})`,
  );
  console.log(
    `  destination: ${driveFiles.length} file(s) matched (${formatSize(sumSize(driveFiles))})`,
  );

  const oversizedCount = repoResult.oversized.length + driveResult.oversized.length;
  if (oversizedCount > 0) {
    console.log(
      `  (${oversizedCount} matching file(s) skipped: larger than ${maxFileSizeMiB} MiB)`,
    );
  }

  if (driveOnly.length === 0) {
    console.log(
      '  Nothing new on the destination side — a first sync would not add files to the repository.',
    );

    return promptYesNo(rl, '\nUse these patterns?', true);
  }

  console.log(
    `\n  ${driveOnly.length} file(s) exist only on the destination, not in the repository ` +
    `(${formatSize(driveOnlySize)}). Unless they are already tracked in gsynchro's sync status, ` +
    'a first sync would copy them into the repository:',
  );

  printPreviewSample(driveOnly);

  const looksLikeALot =
    driveOnly.length > PREVIEW_WARN_FILE_COUNT ||
    driveOnlySize > PREVIEW_WARN_TOTAL_BYTES;

  if (looksLikeALot) {
    console.log(
      '\n  That looks like a lot to bring into the repository — double-check the destination and patterns.',
    );
  }

  return promptYesNo(rl, '\nUse these patterns?', !looksLikeALot);
}

/**
 * Interactively creates or overwrites `.gsynchro/gsynchro.yml`.
 *
 * Returns whether the caller should continue on into the normal watch
 * flow (true), or stop here so the user can review the file first (false).
 */
export async function runSetup(repoRoot: string): Promise<boolean> {
  const configFile = configPath(repoRoot);
  const configAlreadyExists = await pathExists(configFile);

  let existing: Config | undefined;

  if (configAlreadyExists) {
    try {
      existing = await loadConfig(configFile, repoRoot);
    } catch {
      existing = undefined;
    }
  }

  console.log('[gsynchro] setup');
  console.log(`  repo: ${repoRoot}`);

  if (configAlreadyExists) {
    console.log(
      `  Existing configuration found at ${configFile}; current values are offered as defaults.`,
    );
  } else {
    console.log(`  No configuration found at ${configFile}; let's create one.`);
    console.log(
      '  Enter the absolute path of an existing local folder for the other side of the sync.',
    );
    console.log(
      '  It must be a folder provided by your Drive client or filesystem mount, not a Google Drive web URL.',
    );
    console.log(
      '  On Windows and macOS, use Google Drive for desktop; on Linux, use an rclone mount.',
    );
    console.log(
      '  Create a project-specific subfolder in that location before continuing.',
    );
    console.log(
      '  Setup guide: https://github.com/AAE-platform/gsynchro#platform-setup-examples',
    );
  }

  console.log('');

  const discoveredDefaultItems = existing
    ? []
    : await discoverDefaultItemSources(repoRoot);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    let destination: string | undefined;

    while (destination === undefined) {
      const defaultDestination = existing?.destination ?? '';
      const answer = await rl.question(
        `Destination directory${defaultDestination ? ` [${defaultDestination}]` : ''}: `,
      );
      const result = await validateDestinationCandidate(
        repoRoot,
        answer.trim() || defaultDestination,
      );

      if (result.ok) {
        destination = result.resolved;
      } else {
        console.log(`  ${result.error}`);
      }
    }

    let extensions: string[] | undefined;

    while (extensions === undefined) {
      const baseExtensions = existing?.extensions ?? DEFAULT_EXTENSIONS;

      console.log(
        `\n  ${existing ? 'The current configuration' : 'gsynchro'} synchronizes these file extensions${
          existing ? ':' : ' by default:'
        }`,
      );
      console.log(`  ${baseExtensions.join(', ')}`);
      console.log('  You can remove any of them later in .gsynchro/gsynchro.yml.');

      const answer = await rl.question(
        '  Add other extensions, comma-separated (or press Enter to keep these): ',
      );
      const additions = answer
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map(normalizeExtension);

      const invalid = additions.find(
        (extension) => !isValidExtension(extension),
      );

      if (invalid) {
        console.log(
          `  Invalid extension "${invalid}" — expected a dot followed by letters/digits, e.g. ".md".`,
        );
        continue;
      }

      extensions = [...new Set([...baseExtensions, ...additions])];
    }

    let maxFileSizeMiB: number | undefined;

    while (maxFileSizeMiB === undefined) {
      const defaultMaxFileSizeMiB = existing?.maxFileSizeMiB ?? DEFAULT_MAX_FILE_SIZE_MIB;
      const answer = await rl.question(
        `Maximum file size in MiB [${defaultMaxFileSizeMiB}]: `,
      );
      const parsed = Number(answer.trim() || String(defaultMaxFileSizeMiB));

      if (Number.isFinite(parsed) && parsed > 0) {
        maxFileSizeMiB = parsed;
      } else {
        console.log('  Enter a number > 0.');
      }
    }

    let items: string[] | undefined;

    while (items === undefined) {
      const baseItems =
        existing?.items ??
        discoveredDefaultItems.map((source) => source.pattern);

      console.log(
        `\n  ${existing ? 'The current configuration synchronizes:' : 'gsynchro found these locations in this repository and will synchronize them by default:'}`,
      );

      if (existing) {
        for (const item of baseItems) {
          console.log(`  • ${item}`);
        }
      } else {
        for (const item of discoveredDefaultItems) {
          console.log(`  • ${item.description}`);
        }
      }

      console.log('  You can remove any of them later in .gsynchro/gsynchro.yml.');

      const answer = await rl.question(
        '  Add folders or glob patterns, comma-separated (or press Enter to keep these): ',
      );
      const additions = answer
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      const selectedItems = [
        ...new Set([
          ...baseItems,
          ...additions.map(folderOrPatternToItem),
        ]),
      ];

      if (await previewSelection(repoRoot, destination, selectedItems, extensions, maxFileSizeMiB, rl)) {
        items = selectedItems;
      }
    }

    let debounce: number | undefined;

    while (debounce === undefined) {
      const defaultDebounce = existing?.debounce ?? DEFAULT_DEBOUNCE_SECONDS;
      const answer = await rl.question(
        `Debounce seconds [${defaultDebounce}]: `,
      );
      const parsed = Number(answer.trim() || String(defaultDebounce));

      if (Number.isFinite(parsed) && parsed >= 0) {
        debounce = parsed;
      } else {
        console.log('  Enter a number >= 0.');
      }
    }

    console.log('\nConfiguration to write:');
    console.log(`  destination: ${destination}`);
    console.log(`  extensions:  ${extensions.join(', ')}`);
    console.log(`  items:       ${items.join(', ')}`);
    console.log(`  maxFileSizeMiB: ${maxFileSizeMiB}`);
    console.log(`  debounce:    ${debounce}s`);
    console.log('');

    const confirmed = await promptYesNo(
      rl,
      `Write ${path.relative(repoRoot, configFile)}?`,
      true,
    );

    if (!confirmed) {
      console.log('[gsynchro] setup cancelled, nothing was written');
      return false;
    }

    const setupConfig: Config = {
      destination,
      items,
      extensions,
      maxFileSizeMiB,
      debounce,
    };

    if (await writeSynchronizationNotice(destination, setupConfig)) {
      console.log(`[gsynchro] wrote ${noticePath(destination)}`);
    }

    await writeConfigurationMirror(destination, setupConfig);

    await mkdir(configDir(repoRoot), { recursive: true });
    await writeFile(configFile, renderConfigYaml(setupConfig), 'utf8');

    console.log(`[gsynchro] wrote ${configFile}`);

    return await promptYesNo(rl, 'Start gsynchro now?', true);
  } finally {
    rl.close();
  }
}
