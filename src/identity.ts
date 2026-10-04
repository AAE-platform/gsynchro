import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { FILE_IDENTITY_PATTERN } from './constants.js';
import type { CandidateFile } from './types.js';

export async function hashFile(
  absolutePath: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolutePath);

    stream.on('error', reject);

    stream.on('data', (chunk) => {
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve(`sha256:${hash.digest('hex')}`);
    });
  });
}

export function shortHash(hash: string): string {
  return hash.replace(/^sha256:/, '').slice(0, 10);
}

export function isMarkdownPath(relativePath: string): boolean {
  return path.extname(relativePath).toLowerCase() === '.md';
}

export function identityFromContent(content: string): string | undefined {
  return content.match(FILE_IDENTITY_PATTERN)?.[1].toLowerCase();
}

export function addMarkdownIdentity(
  content: string,
  identity: string,
  registeredAt = new Date(),
): string {
  const footprint =
    `<!-- gsynchro:v1 id=${identity} registered=${registeredAt.toISOString()} -->\n`;

  /* Keep YAML frontmatter as the first block in the document. */
  if (content.startsWith('---\n') || content.startsWith('---\r\n')) {
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const closing = content.indexOf(`${newline}---${newline}`, 4);
    if (closing !== -1) {
      const insertAt = closing + newline.length + 3 + newline.length;
      return `${content.slice(0, insertAt)}${footprint.replaceAll('\n', newline)}${content.slice(insertAt)}`;
    }
  }

  return `${footprint}${content}`;
}

/**
 * Makes sure a Markdown file carries an identity footprint, writing it in
 * place when missing. Non-Markdown files have no identity.
 */
export async function ensureMarkdownIdentity(
  file: CandidateFile,
  preferredIdentity?: string,
): Promise<{ identity?: string; changed: boolean }> {
  if (!isMarkdownPath(file.relativePath)) {
    return { changed: false };
  }

  let content: string;
  try {
    content = await readFile(file.absolutePath, 'utf8');
  } catch (error) {
    // Let the scanner handle files removed after candidate collection.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to read ${file.relativePath} while registering identity: ${detail}`,
      { cause: error },
    );
  }

  const existing = identityFromContent(content);
  if (existing) {
    return { identity: existing, changed: false };
  }

  const identity = preferredIdentity ?? randomUUID();
  await writeFile(file.absolutePath, addMarkdownIdentity(content, identity), 'utf8');
  return { identity, changed: true };
}
