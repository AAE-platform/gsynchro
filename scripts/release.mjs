#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8'),
);
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

try {
  const changes = run('git', ['status', '--porcelain'], { capture: true });
  if (changes) {
    throw new Error(
      'Git working tree is not clean. Commit or stash changes before releasing.',
    );
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

  console.log(`Authenticated on npm as ${npmUser}.`);
  console.log(`Current version: ${packageJson.version}`);
  console.log(`Release type: ${releaseType}`);
  console.log('The release will create a version commit and Git tag, then publish to npm.');

  const readline = createInterface({ input: stdin, output: stdout });
  let answer;
  try {
    answer = await readline.question('Continue? [y/N] ');
  } finally {
    readline.close();
  }

  if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
    console.log('Release cancelled.');
    process.exit(0);
  }

  run('npm', ['version', releaseType]);
  const releasedPackage = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  );

  try {
    run('npm', ['publish']);
  } catch (error) {
    console.error(
      '\nThe version commit and tag were created, but publishing failed. ' +
      'Fix npm access and run `npm publish` again; do not bump the version again.',
    );
    throw error;
  }

  console.log(`Published ${releasedPackage.name}@${releasedPackage.version}.`);
} catch (error) {
  console.error(`Release failed: ${error.message}`);
  process.exitCode = 1;
}
