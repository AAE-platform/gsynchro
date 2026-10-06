export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const DEFAULT_MAX_FILE_SIZE_MIB = 10;
export const FALLBACK_SCAN_INTERVAL_MS = 60_000;
export const DEFAULT_DEBOUNCE_SECONDS = 3;
export const STATUS_HISTORY_LIMIT = 50;

export const CONFIG_DIR_NAME = '.gsynchro';
export const CONFIG_FILENAME = 'gsynchro.yml';
export const STATUS_FILENAME = 'gsynchro.status';
export const MACHINE_ID_FILENAME = 'machine-id.json';
export const TRASH_DIR_NAME = '.trash';

export const SYNCHRONIZATION_NOTICE_FILENAME = 'GSYNCHRO.md';
export const SYNCHRONIZATION_NOTICE_MARKER = '<!-- gsynchro synchronization notice: v1 -->';
export const CONFIG_MIRROR_MARKER = '# gsynchro authoritative repository configuration mirror: v1';
export const FILE_IDENTITY_PATTERN = /<!-- gsynchro:v1 id=([0-9a-f-]{36}) registered=([^\s]+) -->/i;

export const CONFIG_GITIGNORE_ENTRIES = [
  'machine-id.json',
  'gsynchro.status',
  'gsynchro.status.tmp-*',
];

export const DEFAULT_ITEM_SOURCES = [
  {
    directory: null,
    pattern: '*.*',
    description: 'project root (not recursive)',
  },
  { directory: 'adr', pattern: 'adr/**/*.*', description: 'adr/ (recursive)' },
  {
    directory: 'decisions',
    pattern: 'decisions/**/*.*',
    description: 'decisions/ (recursive)',
  },
  { directory: 'docs', pattern: 'docs/**/*.*', description: 'docs/ (recursive)' },
  {
    directory: 'mockups',
    pattern: 'mockups/**/*.*',
    description: 'mockups/ (recursive)',
  },
  {
    directory: 'prompts',
    pattern: 'prompts/**/*.*',
    description: 'prompts/ (recursive)',
  },
  { directory: 'tasks', pattern: 'tasks/**/*.*', description: 'tasks/ (recursive)' },
  { directory: 'stack', pattern: 'stack/**/*.*', description: 'stack/ (recursive)' },
  {
    directory: 'documents',
    pattern: 'documents/**/*.*',
    description: 'documents/ (recursive)',
  },
  {
    directory: 'documentation',
    pattern: 'documentation/**/*.*',
    description: 'documentation/ (recursive)',
  },
  {
    directory: 'milestones',
    pattern: 'milestones/**/*.*',
    description: 'milestones/ (recursive)',
  },
  {
    directory: 'governance',
    pattern: 'governance/**/*.*',
    description: 'governance/ (recursive)',
  },
  { directory: 'ai', pattern: 'ai/**/*.*', description: 'ai/ (recursive)' },
  {
    directory: 'agents',
    pattern: 'agents/**/*.*',
    description: 'agents/ (recursive)',
  },
  {
    directory: 'architecture',
    pattern: 'architecture/**/*.*',
    description: 'architecture/ (recursive)',
  },
] as const;

export type DefaultItemSource = (typeof DEFAULT_ITEM_SOURCES)[number];

export const PREVIEW_SAMPLE_SIZE = 15;
export const PREVIEW_WARN_FILE_COUNT = 20;
export const PREVIEW_WARN_TOTAL_BYTES = 2 * 1024 * 1024;

export const DEFAULT_EXTENSIONS = [
  '.md',
  '.txt',
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.pdf',
];

export const EXTENSION_PATTERN = /^\.[a-z0-9]+$/;

export const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  CONFIG_DIR_NAME,
  TRASH_DIR_NAME,
]);
