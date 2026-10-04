import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { SyncService } from '../src/service.js';
import type { SyncResult } from '../src/types.js';
import { createFixture, waitFor, type Fixture } from './helpers.js';

let fx: Fixture | undefined;
let service: SyncService | undefined;

afterEach(async () => {
  await service?.stop();
  await fx?.cleanup();
});

test('the watcher service propagates changes on both sides', async (t) => {
  fx = await createFixture(t.fullName, { debounce: 0.1 });
  const results: SyncResult[] = [];
  service = new SyncService(fx.ctx, {
    fallbackScanIntervalMs: 0,
    onSync: (result) => results.push(result),
  });

  await service.reconcileNow();
  service.start();
  /* Let chokidar finish its initial walk. */
  await new Promise((resolve) => setTimeout(resolve, 500));

  await fx.write('repo', 'docs/from-repo.txt', 'repo');
  await waitFor(() => fx!.exists('drive', 'docs/from-repo.txt'));

  await fx.write('drive', 'docs/from-drive.txt', 'drive');
  await waitFor(() => fx!.exists('repo', 'docs/from-drive.txt'));

  assert.ok(results.every((result) => result.result !== 'failed'));
});

test('stop() waits for the running reconciliation', async (t) => {
  fx = await createFixture(t.fullName);
  await fx.write('repo', 'a.txt', 'a');
  service = new SyncService(fx.ctx, { fallbackScanIntervalMs: 0 });

  const running = service.reconcileNow();
  await service.stop();

  assert.equal((await running).result, 'completed');
  assert.ok(await fx.exists('drive', 'a.txt'));
});

test("gsynchro's own writes are not shown, only confirmed by one more synchronization", async (t) => {
  /*
   * A debounce longer than the watcher's write-settling time (500 ms) plus
   * the destination polling (1 s), as with the 3 s default: all events of
   * a change arrive before the synchronization that applies it.
   */
  fx = await createFixture(t.fullName, { debounce: 2 });
  const results: SyncResult[] = [];
  service = new SyncService(fx.ctx, {
    fallbackScanIntervalMs: 0,
    onSync: (result) => results.push(result),
  });

  await service.reconcileNow();
  service.start();
  await new Promise((resolve) => setTimeout(resolve, 500));

  await fx.write('drive', 'docs/note.md', '# Note\n');
  await waitFor(async () => results.some((result) => result.result === 'completed'), 15_000);
  assert.ok(await fx.exists('repo', 'docs/note.md'));
  const syncsAfterCopy = results.length;

  /* Long enough for any echo to arrive and its synchronization to run. */
  await new Promise((resolve) => setTimeout(resolve, 4500));

  /* The event follows the startup block after a blank line. */
  const eventIndex = fx.output.findIndex((line) => line.startsWith('👀'));
  assert.equal(fx.output[eventIndex - 1], '');
  assert.match(fx.output[eventIndex - 2]!, /^💤/);

  const events = fx.output.filter((line) => line.startsWith('👀'));
  assert.deepEqual(events, ['👀\t[drive] file:docs/note.md ADD']);
  /* The echoes trigger exactly one confirming synchronization. */
  assert.deepEqual(
    results.slice(syncsAfterCopy).map((result) => result.result),
    ['up-to-date'],
  );
});
