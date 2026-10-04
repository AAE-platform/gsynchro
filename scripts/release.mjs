#!/usr/bin/env node

/*
 * Release flow:
 *
 *   1. read the title and description of the change from CURRENT_CHANGE.md
 *   2. check git upstream and npm authentication, run typecheck and tests
 *   3. bump the version (package.json + package-lock.json)
 *   4. add the change at the top of CHANGE_LOG.md and reset CURRENT_CHANGE.md
 *   5. commit every pending change as "[published] vX.Y.Z <title>",
 *      tag vX.Y.Z and push both
 *   6. npm publish
 *
 * Usage: npm run release -- [patch|minor|major]
 */

import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT_CHANGE = path.join(root, 'CURRENT_CHANGE.md');
const CHANGE_LOG = path.join(root, 'CHANGE_LOG.md');

const CURRENT_CHANGE_TEMPLATE = `#

<!--
Title of the change under development goes on the "# " line above; the
description goes below this comment. Keep it updated while developing:
\`npm run release\` moves it into CHANGE_LOG.md and resets this file.
-->
`;

const CHANGE_LOG_HEADER = `# Change log

Newest first. Entries are added by \`npm run release\` from CURRENT_CHANGE.md.
`;

const releaseType = process.argv[2] ?? 'patch';

if (!['patch', 'minor', 'major'].includes(releaseType)) {
  console.error('Usage: npm run release -- [patch|minor|major]');
  process.exit(2);
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32' && command === 'npm',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    if (capture && result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error(`${command} ${args.join(' ')} failed`);
  }

  return capture ? result.stdout.trim() : '';
}

/** `# Title` on the first heading line, everything after it is the description. */
function parseCurrentChange(content) {
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, '');
  const lines = withoutComments.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^#\s/.test(line));
  const title = headingIndex === -1 ? '' : lines[headingIndex].replace(/^#\s+/, '').trim();
  const description = lines
    .slice(headingIndex + 1)
    .join('\n')
    .trim();

  return { title, description };
}

function bumpVersion(version, type) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Cannot bump non X.Y.Z version "${version}"`);
  }
  const [major, minor, patch] = match.slice(1).map(Number);

  return type === 'major'
    ? `${major + 1}.0.0`
    : type === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;
}

/** Newest first: the entry goes before the first "## " heading, or at the end. */
function insertNewestEntry(changeLog, entry) {
  const firstEntry = changeLog.search(/^## /m);
  if (firstEntry === -1) {
    return `${changeLog.trimEnd()}\n\n${entry}`;
  }
  return `${changeLog.slice(0, firstEntry)}${entry}\n${changeLog.slice(firstEntry)}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function confirm(question) {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(`${question} [y/N] `);
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    readline.close();
  }
}

/* Which step we reached, to print the right recovery advice. */
let stage = 'checks';
/* Contents of the files the release rewrites, restored if it fails before committing. */
const originals = new Map();

async function restoreOriginals() {
  for (const [file, content] of originals) {
    await writeFile(file, content, 'utf8');
  }
}

try {
  const { title, description } = parseCurrentChange(
    (await readOptional(CURRENT_CHANGE)) ?? '',
  );

  if (!title) {
    throw new Error(
      'CURRENT_CHANGE.md has no title. Describe the change ("# Title" + description) before releasing.',
    );
  }

  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true });
  try {
    run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { capture: true });
  } catch {
    throw new Error(`Branch "${branch}" has no upstream; set one with "git push -u" first.`);
  }

  let npmUser;
  try {
    npmUser = run('npm', ['whoami'], { capture: true });
  } catch {
    console.log('npm login is required. Starting interactive login…');
    run('npm', ['login']);
    npmUser = run('npm', ['whoami'], { capture: true });
  }

  if (!npmUser) {
    throw new Error('npm login completed, but npm whoami returned no username.');
  }

  console.log('\nRunning typecheck and tests…');
  run('npm', ['run', 'typecheck']);
  run('npm', ['test']);

  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const version = bumpVersion(packageJson.version, releaseType);
  const commitMessage = `[published] v${version} ${title}`;
  const pending = run('git', ['status', '--porcelain'], { capture: true });

  console.log(`\nnpm user:  ${npmUser}`);
  console.log(`Branch:    ${branch}`);
  console.log(`Version:   ${packageJson.version} -> ${version} (${releaseType})`);
  console.log(`Commit:    ${commitMessage}`);
  console.log(`\n${description || '(no description)'}\n`);
  console.log('Files committed with the release (plus package.json, package-lock.json, CHANGE_LOG.md, CURRENT_CHANGE.md):');
  console.log(pending ? pending.replace(/^/gm, '  ') : '  (no other changes)');
  console.log('\nThe release commits all of the above, tags it, pushes, then publishes to npm.');

  if (!(await confirm('Continue?'))) {
    console.log('Release cancelled; nothing was changed.');
    process.exit(0);
  }

  for (const file of [
    path.join(root, 'package.json'),
    path.join(root, 'package-lock.json'),
    CHANGE_LOG,
    CURRENT_CHANGE,
  ]) {
    const content = await readOptional(file);
    if (content !== undefined) {
      originals.set(file, content);
    }
  }

  stage = 'files';
  run('npm', ['version', version, '--no-git-tag-version']);

  const changeLog = (await readOptional(CHANGE_LOG)) ?? CHANGE_LOG_HEADER;
  const entry =
    `## v${version} — ${title}\n\n` +
    `_${today()}_\n` +
    (description ? `\n${description}\n` : '');
  await writeFile(CHANGE_LOG, insertNewestEntry(changeLog, entry), 'utf8');
  await writeFile(CURRENT_CHANGE, CURRENT_CHANGE_TEMPLATE, 'utf8');

  run('git', ['add', '--all']);
  run('git', ['commit', '--message', commitMessage]);
  stage = 'committed';
  run('git', ['tag', '--annotate', `v${version}`, '--message', commitMessage]);

  stage = 'tagged';
  run('git', ['push', '--follow-tags']);

  stage = 'pushed';
  run('npm', ['publish']);

  console.log(`\nPublished ${packageJson.name}@${version}.`);
} catch (error) {
  console.error(`\nRelease failed: ${error.message}`);

  if (stage === 'files') {
    try {
      run('git', ['reset', '--quiet']);
      await restoreOriginals();
      stage = 'restored';
    } catch {
      /* Fall through to the manual advice below. */
    }
  }

  const advice = {
    checks: 'Nothing was changed.',
    restored: 'Nothing was committed; package.json, package-lock.json, CHANGE_LOG.md and CURRENT_CHANGE.md were restored.',
    files:
      'Nothing was committed, but restoring the release files failed: check package.json, package-lock.json, ' +
      'CHANGE_LOG.md and CURRENT_CHANGE.md (the change description may need to be rewritten) before retrying.',
    committed:
      'The release commit exists locally but the tag was not created. Create it with ' +
      '`git tag -a vX.Y.Z -m "<commit message>"`, then `git push --follow-tags` and `npm publish`.',
    tagged:
      'The release commit and tag are local, but the push failed. Fix Git access, then run ' +
      '`git push --follow-tags` followed by `npm publish`; do not run the release script again.',
    pushed:
      'The release commit and tag were pushed, but publishing failed. Fix npm access and run ' +
      '`npm publish`; do not bump the version again.',
  };
  console.error(advice[stage]);
  process.exitCode = 1;
}
