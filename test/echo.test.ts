import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { isEchoEvent } from '../src/echo.js';
import { createFixture, type Fixture } from './helpers.js';

let fx: Fixture;

beforeEach(async (t) => {
  fx = await createFixture(t.fullName);
});

afterEach(async () => {
  await fx.cleanup();
});

const echo = (side: 'repo' | 'drive', type: string, path: string) =>
  isEchoEvent(fx.ctx, side, type, path);

test("gsynchro's own copy is an echo; a later edit is not", async () => {
  await fx.write('repo', 'docs/a.txt', 'a');
  await fx.sync();

  assert.equal(await echo('drive', 'add', 'docs/a.txt'), true);
  assert.equal(await echo('repo', 'add', 'docs/a.txt'), true);

  await fx.write('drive', 'docs/a.txt', 'edited');
  assert.equal(await echo('drive', 'change', 'docs/a.txt'), false);
});

test("the Markdown identity footprint written by gsynchro is an echo", async () => {
  await fx.write('repo', 'docs/a.md', '# A\n');
  await fx.sync();

  assert.equal(await echo('repo', 'change', 'docs/a.md'), true);
  assert.equal(await echo('drive', 'add', 'docs/a.md'), true);
});

test("a propagated deletion is an echo; a new deletion is not", async () => {
  await fx.write('repo', 'docs/a.txt', 'a');
  await fx.write('repo', 'docs/b.txt', 'b');
  await fx.sync();

  await fx.remove('repo', 'docs/a.txt');
  await fx.sync();
  assert.equal(await echo('drive', 'unlink', 'docs/a.txt'), true);

  await fx.remove('drive', 'docs/b.txt');
  assert.equal(await echo('drive', 'unlink', 'docs/b.txt'), false);
});

test('directory events are echoes only when they match tracked files', async () => {
  await fx.write('repo', 'docs/a.txt', 'a');
  await fx.sync();

  assert.equal(await echo('drive', 'addDir', 'docs'), true);
  assert.equal(await echo('drive', 'unlinkDir', 'docs'), false);
  assert.equal(await echo('drive', 'addDir', 'tasks'), false);
  assert.equal(await echo('drive', 'unlinkDir', 'tasks'), true);
});

test('the configuration mirror is an echo until someone edits it', async () => {
  await fx.sync();

  assert.equal(await echo('drive', 'change', '.gsynchro/gsynchro.yml'), true);

  await fx.write('drive', '.gsynchro/gsynchro.yml', 'edited: true\n');
  assert.equal(await echo('drive', 'change', '.gsynchro/gsynchro.yml'), false);
});

test('without a saved state nothing is an echo', async () => {
  await fx.write('drive', 'docs/a.txt', 'a');

  assert.equal(await echo('drive', 'add', 'docs/a.txt'), false);
});
