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
