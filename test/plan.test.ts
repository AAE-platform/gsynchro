import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildSyncPlan, detectMoves } from '../src/plan.js';
import type { CurrentState, FileSnapshot, StatusFile } from '../src/types.js';

function snap(hash: string, identity?: string): FileSnapshot {
  return { hash, size: 1, mtimeMs: 1, ...(identity ? { identity } : {}) };
}

function state(
  repo: Record<string, FileSnapshot>,
  drive: Record<string, FileSnapshot>,
): CurrentState {
  return {
    repo: new Map(Object.entries(repo)),
    drive: new Map(Object.entries(drive)),
    skipped: [],
    duplicateIdentities: [],
  };
}

function synced(files: Record<string, FileSnapshot>): StatusFile {
  return {
    version: 1,
    files: Object.fromEntries(
      Object.entries(files).map(([path, snapshot]) => [
        path,
        {
          ...(snapshot.identity ? { identity: snapshot.identity } : {}),
          commonHash: snapshot.hash,
          repo: snapshot,
          drive: snapshot,
        },
      ]),
    ),
  };
}

const empty: StatusFile = { version: 1, files: {} };

describe('buildSyncPlan', () => {
  /*
   * Decision table after a baseline where `f` was synchronized with hash A.
   * null = absent.
   */
  const cases: Array<{
    name: string;
    repo: string | null;
    drive: string | null;
    expected: Array<{ type: string; reason: string }>;
  }> = [
    { name: 'unchanged', repo: 'A', drive: 'A', expected: [] },
    { name: 'both changed identically', repo: 'B', drive: 'B', expected: [] },
    { name: 'deleted on both', repo: null, drive: null, expected: [] },
    { name: 'repo changed', repo: 'B', drive: 'A', expected: [{ type: 'copy', reason: 'changed on repository' }] },
    { name: 'drive changed', repo: 'A', drive: 'B', expected: [{ type: 'copy', reason: 'changed on Drive' }] },
    { name: 'both changed', repo: 'B', drive: 'C', expected: [{ type: 'copy', reason: 'conflict, repository wins' }] },
    { name: 'repo deleted', repo: null, drive: 'A', expected: [{ type: 'delete', reason: 'deleted on repository' }] },
    { name: 'drive deleted', repo: 'A', drive: null, expected: [{ type: 'delete', reason: 'deleted on Drive' }] },
    {
      name: 'repo deleted, drive changed',
      repo: null,
      drive: 'B',
      expected: [{ type: 'delete', reason: 'delete/modify conflict, repository deletion wins' }],
    },
    {
      name: 'drive deleted, repo changed',
      repo: 'B',
      drive: null,
      expected: [{ type: 'copy', reason: 'conflict, repository wins' }],
    },
  ];

  for (const { name, repo, drive, expected } of cases) {
    test(name, () => {
      const plan = buildSyncPlan(
        synced({ f: snap('A') }),
        state(
          repo ? { f: snap(repo) } : {},
          drive ? { f: snap(drive) } : {},
        ),
      );

      assert.deepEqual(
        plan.map(({ type, reason }) => ({ type, reason })),
        expected,
      );
    });
  }

  test('without a baseline, files present on one side are copied', () => {
    const plan = buildSyncPlan(
      empty,
      state({ r: snap('A') }, { d: snap('B') }),
    );

    assert.deepEqual(
      plan.map((op) => op.type === 'copy' && `${op.path}:${op.from}->${op.to}`),
      ['r:repo->drive', 'd:drive->repo'],
    );
  });

  test('a path skipped on one side is left alone', () => {
    const current = state({}, { f: snap('A') });
    current.skipped.push({ side: 'repo', relativePath: 'f', size: 1 });

    assert.deepEqual(buildSyncPlan(synced({ f: snap('A') }), current), []);
    assert.deepEqual(buildSyncPlan(empty, current), []);
  });

  test('a repository delete always targets the destination', () => {
    const [operation] = buildSyncPlan(synced({ f: snap('A') }), state({}, { f: snap('A') }));

    assert.equal(operation?.type, 'delete');
    assert.equal(operation?.type === 'delete' && operation.side, 'drive');
  });
});

describe('detectMoves', () => {
  const id = '11111111-1111-1111-1111-111111111111';

  test('detects a move on the destination', () => {
    const { operations } = detectMoves(
      synced({ 'todo/t.md': snap('A', id) }),
      state({ 'todo/t.md': snap('A', id) }, { 'done/t.md': snap('A', id) }),
    );

    assert.deepEqual(operations, [{
      type: 'move',
      from: 'drive',
      to: 'repo',
      previousPath: 'todo/t.md',
      path: 'done/t.md',
      reason: 'moved on drive',
    }]);
  });

  test('a moved and edited file is still moved (the edit travels with it)', () => {
    const plan = buildSyncPlan(
      synced({ 'todo/t.md': snap('A', id) }),
      state({ 'done/t.md': snap('B', id) }, { 'todo/t.md': snap('A', id) }),
    );

    assert.deepEqual(plan.map((op) => op.type), ['move']);
  });

  test('no move when the side left behind also changed', () => {
    const plan = buildSyncPlan(
      synced({ 'todo/t.md': snap('A', id) }),
      state({ 'done/t.md': snap('A', id) }, { 'todo/t.md': snap('B', id) }),
    );

    assert.ok(plan.every((op) => op.type !== 'move'));
  });

  test('duplicated identities are never treated as moves', () => {
    const { operations } = detectMoves(
      synced({ 'a.md': snap('A', id) }),
      state(
        { 'a.md': snap('A', id) },
        { 'b.md': snap('A', id), 'c.md': snap('A', id) },
      ),
    );

    assert.deepEqual(operations, []);
  });
});
