import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { MAX_FILE_SIZE } from '../src/constants.js';
import { identityFromContent } from '../src/identity.js';
import { createFixture, stripIdentity, type Fixture } from './helpers.js';

let fx: Fixture;

beforeEach(async (t) => {
  fx = await createFixture(t.fullName);
});

afterEach(async () => {
  await fx.cleanup();
});

describe('initial synchronization', () => {
  test('copies repository-only files to the destination', async () => {
    await fx.write('repo', 'notes.txt', 'from repo');
    await fx.write('repo', 'docs/a/b.txt', 'nested');

    const result = await fx.sync();

    assert.equal(result.result, 'completed');
    assert.equal(await fx.read('drive', 'notes.txt'), 'from repo');
    assert.equal(await fx.read('drive', 'docs/a/b.txt'), 'nested');
  });

  test('imports destination-only files into the repository', async () => {
    await fx.write('drive', 'tasks/todo/T-1.txt', 'task');

    assert.equal((await fx.sync()).result, 'completed');
    assert.equal(await fx.read('repo', 'tasks/todo/T-1.txt'), 'task');
  });

  test('repository wins when both sides differ at the same path', async () => {
    await fx.write('repo', 'notes.txt', 'repo version');
    await fx.write('drive', 'notes.txt', 'drive version');

    const result = await fx.sync();

    assert.equal(result.operations[0]?.reason, 'initial conflict, repository wins');
    assert.equal(await fx.read('drive', 'notes.txt'), 'repo version');
  });

  test('a second run without changes is up to date', async () => {
    await fx.write('repo', 'notes.txt', 'x');
    await fx.sync();

    const result = await fx.sync();

    assert.equal(result.result, 'up-to-date');
    assert.deepEqual(result.operations, []);
  });

  test('writes the notice and the configuration mirror on the destination', async () => {
    await fx.sync();

    assert.ok(await fx.exists('drive', '.gsynchro/gsynchro.yml'));
    assert.ok(await fx.exists('drive', '.gsynchro/gsynchro.status'));
    assert.ok(await fx.exists('repo', '.gsynchro/gsynchro.status'));
  });
});

describe('changes after a baseline', () => {
  beforeEach(async () => {
    await fx.write('repo', 'notes.txt', 'v1');
    await fx.sync();
  });

  test('propagates a repository change', async () => {
    await fx.write('repo', 'notes.txt', 'v2 from repo');

    const result = await fx.sync();

    assert.equal(result.operations[0]?.reason, 'changed on repository');
    assert.equal(await fx.read('drive', 'notes.txt'), 'v2 from repo');
  });

  test('propagates a destination change', async () => {
    await fx.write('drive', 'notes.txt', 'v2 from drive');

    const result = await fx.sync();

    assert.equal(result.operations[0]?.reason, 'changed on Drive');
    assert.equal(await fx.read('repo', 'notes.txt'), 'v2 from drive');
  });

  test('repository wins when both sides changed', async () => {
    await fx.write('repo', 'notes.txt', 'repo edit');
    await fx.write('drive', 'notes.txt', 'drive edit!');

    const result = await fx.sync();

    assert.equal(result.operations[0]?.reason, 'conflict, repository wins');
    assert.equal(await fx.read('drive', 'notes.txt'), 'repo edit');
  });

  test('a repository deletion moves the destination copy to its trash', async () => {
    await fx.remove('repo', 'notes.txt');

    await fx.sync();

    assert.equal(await fx.exists('drive', 'notes.txt'), false);
    const trash = await fx.trash('drive');
    assert.equal(trash.length, 1);
    assert.match(trash[0]!, /-notes-[0-9a-f]{10}\.txt$/);
  });

  test('a destination deletion moves the repository copy to its trash', async () => {
    await fx.remove('drive', 'notes.txt');

    await fx.sync();

    assert.equal(await fx.exists('repo', 'notes.txt'), false);
    assert.equal((await fx.trash('repo')).length, 1);
  });

  test('a repository deletion wins over a destination edit', async () => {
    await fx.remove('repo', 'notes.txt');
    await fx.write('drive', 'notes.txt', 'edited on drive');

    const result = await fx.sync();

    assert.equal(result.operations[0]?.reason, 'delete/modify conflict, repository deletion wins');
    assert.equal(await fx.exists('drive', 'notes.txt'), false);
  });

  test('a destination deletion of a file edited in the repository restores it', async () => {
    await fx.remove('drive', 'notes.txt');
    await fx.write('repo', 'notes.txt', 'edited in repo');

    await fx.sync();

    assert.equal(await fx.read('drive', 'notes.txt'), 'edited in repo');
  });
});

describe('filters and safety rules', () => {
  test('ignores extensions that are not configured', async () => {
    await fx.write('repo', 'docs/code.ts', 'export {}');
    await fx.write('drive', 'docs/data.json', '{}');

    await fx.sync();

    assert.equal(await fx.exists('drive', 'docs/code.ts'), false);
    assert.equal(await fx.exists('repo', 'docs/data.json'), false);
  });

  test('ignores paths outside the configured items', async () => {
    await fx.write('repo', 'src/readme.md', 'not selected');
    await fx.write('drive', 'other/notes.txt', 'drive only');

    await fx.sync();

    assert.equal(await fx.exists('drive', 'src/readme.md'), false);
    assert.equal(await fx.exists('repo', 'other/notes.txt'), false);
  });

  test('a root pattern is not recursive', async () => {
    await fx.write('repo', 'nested/deep.txt', 'x');

    await fx.sync();

    assert.equal(await fx.exists('drive', 'nested/deep.txt'), false);
  });

  test('never synchronizes excluded directories', async () => {
    await fx.write('repo', 'docs/node_modules/x.md', 'x');
    await fx.write('repo', 'docs/.git/y.txt', 'y');
    await fx.write('drive', 'docs/.trash/z.txt', 'z');

    await fx.sync();

    assert.equal(await fx.exists('drive', 'docs/node_modules/x.md'), false);
    assert.equal(await fx.exists('drive', 'docs/.git/y.txt'), false);
    assert.equal(await fx.exists('repo', 'docs/.trash/z.txt'), false);
  });

  test('never imports the destination GSYNCHRO.md notice', async () => {
    await fx.write('drive', 'GSYNCHRO.md', 'notice');

    await fx.sync();

    assert.equal(await fx.exists('repo', 'GSYNCHRO.md'), false);
  });

  test('skips oversized files and does not treat them as deleted', async () => {
    await fx.write('repo', 'big.txt', 'small');
    await fx.sync();

    await fx.write('repo', 'big.txt', Buffer.alloc(MAX_FILE_SIZE + 1));
    const result = await fx.sync();

    assert.notEqual(result.result, 'failed');
    assert.equal(await fx.read('drive', 'big.txt'), 'small');
    assert.equal((await fx.trash('drive')).length, 0);

    /* Nor is the stale copy later imported over the large file. */
    assert.equal((await fx.sync()).result, 'up-to-date');
    assert.equal((await fx.read('repo', 'big.txt')).length, MAX_FILE_SIZE + 1);
  });

  test('does not follow or copy symbolic links', async () => {
    await fx.write('repo', 'target.txt', 'real');
    await symlink(path.join(fx.root('repo'), 'target.txt'), path.join(fx.root('repo'), 'link.txt'));

    await fx.sync();

    assert.ok(await fx.exists('drive', 'target.txt'));
    assert.equal(await fx.exists('drive', 'link.txt'), false);
  });

  test('an unreadable file aborts the run instead of looking deleted', {
    skip: process.getuid?.() === 0 ? 'root can read any file' : false,
  }, async () => {
    await fx.write('repo', 'a.txt', 'a');
    await fx.write('repo', 'b.txt', 'b');
    await fx.sync();

    await fx.write('drive', 'a.txt', 'changed');
    /* Changed, so its snapshot cannot be reused without reading it. */
    await fx.write('drive', 'b.txt', 'changed too');
    const unreadable = path.join(fx.root('drive'), 'b.txt');
    await chmod(unreadable, 0o000);
    try {
      const result = await fx.sync();

      assert.equal(result.result, 'failed');
      assert.equal(await fx.read('repo', 'a.txt'), 'a');
      assert.ok(await fx.exists('repo', 'b.txt'));
    } finally {
      await chmod(unreadable, 0o644);
    }
  });
});

describe('destination guard', () => {
  test('refuses an emptied (unmounted-looking) destination', async () => {
    await fx.write('repo', 'docs/a.txt', 'a');
    await fx.write('repo', 'docs/b.txt', 'b');
    await fx.sync();

    /* What an unmounted FUSE mount point looks like: an empty directory. */
    await rm(fx.root('drive'), { recursive: true });
    await mkdir(fx.root('drive'));

    const result = await fx.sync();

    assert.equal(result.result, 'failed');
    assert.match(result.error ?? '', /looks unmounted/);
    assert.equal(await fx.read('repo', 'docs/a.txt'), 'a');
    assert.equal((await fx.trash('repo')).length, 0);
    /* Failure bookkeeping must not recreate the marker it checks for. */
    assert.deepEqual(await readdir(fx.root('drive')), []);
    assert.equal((await fx.sync()).result, 'failed');
  });

  test('refuses a missing destination', async () => {
    await rm(fx.root('drive'), { recursive: true });

    const result = await fx.sync();

    assert.equal(result.result, 'failed');
  });

  test('accepts an empty destination on the very first run', async () => {
    await fx.write('repo', 'a.txt', 'a');

    assert.equal((await fx.sync()).result, 'completed');
  });
});

describe('Markdown identity', () => {
  test('adds the same identity to both copies, after frontmatter', async () => {
    await fx.write('repo', 'docs/spec.md', '---\ntitle: Spec\n---\n# Spec\n');

    await fx.sync();

    const repo = await fx.read('repo', 'docs/spec.md');
    const drive = await fx.read('drive', 'docs/spec.md');
    assert.equal(repo, drive);
    assert.ok(identityFromContent(repo));
    assert.ok(repo.startsWith('---\ntitle: Spec\n---\n<!-- gsynchro:v1 id='));
    assert.equal(stripIdentity(repo), '---\ntitle: Spec\n---\n# Spec\n');
  });

  test('registers files first seen on the destination', async () => {
    await fx.write('drive', 'tasks/todo/T-2.md', '# Task\n');

    await fx.sync();

    const repo = await fx.read('repo', 'tasks/todo/T-2.md');
    assert.ok(identityFromContent(repo));
    assert.equal(repo, await fx.read('drive', 'tasks/todo/T-2.md'));
  });

  test('propagates a move instead of duplicating the file', async () => {
    await fx.write('repo', 'tasks/todo/T-3.md', '# Task 3\n');
    await fx.sync();

    await mkdir(path.join(fx.root('drive'), 'tasks/done'), { recursive: true });
    const content = await fx.read('drive', 'tasks/todo/T-3.md');
    await fx.write('drive', 'tasks/done/T-3.md', content);
    await fx.remove('drive', 'tasks/todo/T-3.md');

    const result = await fx.sync();

    assert.equal(result.operations.length, 1);
    assert.equal(result.operations[0]?.type, 'move');
    assert.equal(await fx.exists('repo', 'tasks/todo/T-3.md'), false);
    assert.equal(await fx.read('repo', 'tasks/done/T-3.md'), content);
    assert.equal((await fx.trash('repo')).length, 1);
  });
});

describe('status', () => {
  test('keeps an accumulating history on both sides', async () => {
    await fx.write('repo', 'a.txt', '1');
    await fx.sync();
    await fx.write('repo', 'a.txt', '22');
    await fx.sync();
    await fx.sync();

    const repoStatus = await fx.status('repo');
    const driveStatus = await fx.status('drive');

    assert.deepEqual(
      repoStatus.history?.map((entry) => entry.result),
      ['completed', 'completed', 'up-to-date'],
    );
    assert.equal(driveStatus.history?.length, 3);
    assert.equal(repoStatus.machineId, 'test-machine');
  });

  test('records the common hash of every synchronized file', async () => {
    await fx.write('repo', 'a.txt', 'a');
    await fx.sync();

    const entry = (await fx.status()).files['a.txt'];

    assert.ok(entry?.commonHash?.startsWith('sha256:'));
    assert.equal(entry?.repo?.hash, entry?.drive?.hash);
  });

  test('a malformed status aborts instead of resetting the baseline', async () => {
    await fx.write('repo', 'a.txt', 'a');
    await fx.sync();
    await fx.write('repo', '.gsynchro/gsynchro.status', '{"version": 2}');
    await fx.remove('drive', 'a.txt');

    const result = await fx.sync();

    assert.equal(result.result, 'failed');
    assert.ok(await fx.exists('repo', 'a.txt'));
  });
});

describe('console output', () => {
  test('a synchronization with operations', async () => {
    await fx.write('repo', 'notes.txt', 'v1');
    await fx.sync();
    await fx.write('repo', 'notes.txt', 'v2 changed');
    const before = fx.output.length;

    await fx.sync();

    assert.deepEqual(
      fx.output.slice(before).filter(Boolean).map((line) => line.replace(/\(\d+ ms\)/, '(N ms)')),
      [
        '♻️\tsyncing ...',
        '📝\t[repo] file:notes.txt CHANGED',
        '✅\t1 operation applied (N ms)',
      ],
    );
  });

  test('a synchronization with nothing to do', async () => {
    await fx.sync();
    const before = fx.output.length;

    await fx.sync();

    assert.deepEqual(
      fx.output.slice(before).filter(Boolean).map((line) => line.replace(/\(\d+ ms\)/, '(N ms)')),
      ['♻️\tsyncing ...', '💤\tnothing to do (N ms)'],
    );
  });

  /* Renames, moves and both, done on the destination like a Drive user would. */
  const relocations: Array<[string, string, string, string]> = [
    ['rename', 'tasks/A.md', 'tasks/B.md', '✍️\t[drive] file:tasks/B.md RENAMED old name: A.md'],
    ['move', 'tasks/todo/A.md', 'tasks/done/A.md', '➡️\t[drive] file:A.md MOVED tasks/todo -> tasks/done'],
    ['move and rename', 'tasks/todo/A.md', 'tasks/done/B.md', '➡️\t[drive] file:tasks/done/B.md MOVED from: tasks/todo/A.md'],
  ];

  for (const [name, from, to, expected] of relocations) {
    test(`a ${name}`, async () => {
      await fx.write('repo', from, '# A\n');
      await fx.sync();
      await mkdir(path.dirname(path.join(fx.root('drive'), to)), { recursive: true });
      await rename(path.join(fx.root('drive'), from), path.join(fx.root('drive'), to));
      const before = fx.output.length;

      const result = await fx.sync();

      assert.deepEqual(result.operations.map((op) => op.type), ['move']);
      assert.ok(fx.output.slice(before).includes(expected), fx.output.slice(before).join('\n'));
      assert.ok(await fx.exists('repo', to));
      assert.equal(await fx.exists('repo', from), false);
    });
  }

  test('a failed synchronization', async () => {
    await rm(fx.root('drive'), { recursive: true });

    await fx.sync();

    assert.match(fx.output.at(-1)!, /^💥\tsync failed \(\d+ ms\): /);
  });
});
