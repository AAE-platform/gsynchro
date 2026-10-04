import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseConfig, renderConfigYaml } from '../src/config.js';
import { DEFAULT_EXTENSIONS } from '../src/constants.js';
import { addMarkdownIdentity, identityFromContent } from '../src/identity.js';
import { clockTime, createLogger, withTimestamp } from '../src/output.js';
import {
  directoryMayContainConfiguredItem,
  folderOrPatternToItem,
  isAllowedRelativePath,
  isPathInside,
} from '../src/paths.js';

const id = '22222222-2222-2222-2222-222222222222';
const at = new Date('2026-01-01T00:00:00.000Z');

describe('paths', () => {
  test('folderOrPatternToItem', () => {
    assert.equal(folderOrPatternToItem('docs'), 'docs/**/*.*');
    assert.equal(folderOrPatternToItem('docs/'), 'docs/**/*.*');
    assert.equal(folderOrPatternToItem('.'), '*.*');
    assert.equal(folderOrPatternToItem('README.md'), 'README.md');
    assert.equal(folderOrPatternToItem('tasks/*.md'), 'tasks/*.md');
  });

  test('isAllowedRelativePath', () => {
    const extensions = new Set(['.md', '.txt']);

    assert.ok(isAllowedRelativePath('docs/a.MD', extensions));
    assert.ok(!isAllowedRelativePath('docs/a.ts', extensions));
    assert.ok(!isAllowedRelativePath('GSYNCHRO.md', extensions));
    assert.ok(isAllowedRelativePath('docs/GSYNCHRO.md', extensions));
    assert.ok(!isAllowedRelativePath('.gsynchro/x.md', extensions));
    assert.ok(!isAllowedRelativePath('a/node_modules/x.md', extensions));
  });

  test('isPathInside', () => {
    assert.ok(isPathInside('/a', '/a/b'));
    assert.ok(!isPathInside('/a', '/a'));
    assert.ok(!isPathInside('/a', '/ab'));
    assert.ok(!isPathInside('/a/b', '/a'));
  });

  describe('directoryMayContainConfiguredItem', () => {
    const items = ['*.*', 'docs/**/*.*', 'tasks/*/*.md', 'README.md'];
    const cases: Array<[string, boolean]> = [
      ['', true],
      ['docs', true],
      ['docs/a/b/c', true],
      ['tasks', true],
      ['tasks/todo', true],
      ['tasks/todo/deep', false],
      ['src', false],
      ['README.md', false],
    ];

    for (const [directory, expected] of cases) {
      test(`${directory || '(root)'} → ${expected}`, () => {
        assert.equal(directoryMayContainConfiguredItem(directory, items), expected);
      });
    }
  });
});

describe('Markdown identity footprint', () => {
  test('is prepended when there is no frontmatter', () => {
    const result = addMarkdownIdentity('# Title\n', id, at);

    assert.equal(
      result,
      `<!-- gsynchro:v1 id=${id} registered=2026-01-01T00:00:00.000Z -->\n# Title\n`,
    );
    assert.equal(identityFromContent(result), id);
  });

  test('goes after YAML frontmatter', () => {
    const result = addMarkdownIdentity('---\na: 1\n---\nBody\n', id, at);

    assert.ok(result.startsWith('---\na: 1\n---\n<!-- gsynchro:v1'));
    assert.ok(result.endsWith('-->\nBody\n'));
  });

  test('keeps CRLF line endings', () => {
    const result = addMarkdownIdentity('---\r\na: 1\r\n---\r\nBody\r\n', id, at);

    assert.ok(result.startsWith('---\r\na: 1\r\n---\r\n<!-- gsynchro:v1'));
    assert.ok(!/[^\r]\n/.test(result));
  });

  test('unterminated frontmatter is treated as content', () => {
    assert.ok(addMarkdownIdentity('---\nno end\n', id, at).startsWith('<!-- gsynchro:v1'));
  });
});

describe('configuration', () => {
  test('applies defaults and resolves the destination against the repository', () => {
    const config = parseConfig('destination: ../drive\nitems: ["docs/**/*.*"]\n', '/work/repo');

    assert.deepEqual(config, {
      destination: '/work/drive',
      debounce: 3,
      items: ['docs/**/*.*'],
      extensions: DEFAULT_EXTENSIONS,
    });
  });

  test('normalizes extensions', () => {
    const config = parseConfig('destination: /d\nitems: ["*.*"]\nextensions: ["MD", ".Txt"]\n', '/r');

    assert.deepEqual(config.extensions, ['.md', '.txt']);
  });

  const invalid: Array<[string, string]> = [
    ['missing destination', 'items: ["*.*"]'],
    ['empty items', 'destination: /d\nitems: []'],
    ['negative debounce', 'destination: /d\nitems: ["*.*"]\ndebounce: -1'],
    ['NaN debounce', 'destination: /d\nitems: ["*.*"]\ndebounce: .nan'],
    ['bad extension', 'destination: /d\nitems: ["*.*"]\nextensions: [".tar.gz"]'],
    ['empty file', ''],
  ];

  for (const [name, yaml] of invalid) {
    test(`rejects ${name}`, () => {
      assert.throws(() => parseConfig(yaml, '/r'), /gsynchro\.yml/);
    });
  }

  test('rendered YAML parses back to the same configuration', () => {
    const config = {
      destination: '/mnt/drive/project',
      debounce: 5,
      items: ['docs/**/*.*', 'tasks/"quoted".md'],
      extensions: ['.md', '.pdf'],
    };

    assert.deepEqual(parseConfig(renderConfigYaml(config), '/r'), config);
  });
});

describe('console output', () => {
  const date = new Date(2026, 0, 2, 3, 4, 5);

  test('clockTime is HH:MM:ss', () => {
    assert.equal(clockTime(date), '03:04:05');
  });

  test('every non-empty line gets the time, blank lines stay blank', () => {
    assert.equal(
      withTimestamp('\nfirst\n  second', date),
      '\n03:04:05 first\n03:04:05   second',
    );
  });

  test('the logger stamps info, warnings, errors and enabled debug lines', () => {
    const out: string[] = [];
    const err: string[] = [];
    const log = createLogger({ out: (l) => out.push(l), err: (l) => err.push(l) }, true);

    log.info('a');
    log.warn('b');
    log.error('c');
    log.debug('d', { x: 1 });

    const stamped = /^\d{2}:\d{2}:\d{2} /;
    assert.ok([...out, ...err].every((line) => stamped.test(line)));
    assert.equal(err.length, 2);
    assert.match(out[1]!, /\[debug\] d \{ x: 1 \}$/);
  });

  test('debug lines are dropped unless enabled', () => {
    const out: string[] = [];
    createLogger({ out: (l) => out.push(l), err: () => {} }, false).debug('x');
    assert.deepEqual(out, []);
  });
});
