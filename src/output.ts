import pc from 'picocolors';
import process from 'node:process';
import { format } from 'node:util';

import type { Logger, Side } from './types.js';

export const STYLED_OUTPUT =
  Boolean(process.stdout.isTTY) &&
  !process.env.NO_COLOR &&
  !process.argv.slice(2).includes('--no-color');

const TRANSIENT_OUTPUT = Boolean(process.stdout.isTTY);

function fitProgressLine(message: string): string {
  const columns = process.stdout.columns;
  if (!columns || message.length < columns) {
    return message;
  }

  return `${[...message].slice(0, Math.max(1, columns - 2)).join('')}…`;
}

/* Colors are on only for styled output, whatever picocolors detects. */
const colors = pc.createColors(STYLED_OUTPUT);

type Tone = 'bold' | 'dim' | 'gray' | 'red' | 'green' | 'yellow' | 'blue' | 'cyan';

export function paint(value: string, ...tones: Tone[]): string {
  return tones.reduceRight((text, tone) => colors[tone](text), value);
}

/*
 * A tab, not spaces, after the emoji: terminals disagree on the width of
 * emoji such as ♻️ (a text symbol plus U+FE0F), but a tab always moves to
 * the next multiple of 8 from wherever the terminal thinks the cursor is,
 * so the text lines up after any emoji.
 */
export function emojiText(emoji: string, text: string): string {
  return `${emoji}\t${text}`;
}

export function label(
  emoji: string,
  plain: string,
  tone: Tone,
): string {
  return STYLED_OUTPUT
    ? emojiText(emoji, paint(plain, 'bold', tone))
    : `[${plain.toLowerCase()}]`;
}

export function sideLabel(side: Side): string {
  return STYLED_OUTPUT
    ? paint(side, 'bold', side === 'repo' ? 'blue' : 'cyan')
    : side;
}

export function printBanner(log: Logger, version: string): void {
  if (STYLED_OUTPUT) {
    log.info(`${paint(emojiText('🔁', 'gsynchro'), 'bold', 'cyan')} ${paint(`v${version}`, 'bold', 'yellow')} ${paint('bidirectional file sync', 'dim')}`);
    return;
  }

  log.info(`[gsynchro v${version}] bidirectional file sync`);
}

export function formatElapsed(startedAt: bigint): string {
  const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
  return elapsedMs < 1_000
    ? `${elapsedMs} ms`
    : `${(elapsedMs / 1_000).toFixed(1)} s`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export interface LogSink {
  out(line: string): void;
  err(line: string): void;
  /** Write transient output without appending a newline. */
  write?(text: string): void;
}

/** Local wall-clock time as HH:MM:ss.fff. */
export function clockTime(date = new Date()): string {
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
  return `${time}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

/** Prefixes every non-empty line of a message with the time. */
export function withTimestamp(message: string, date = new Date()): string {
  const time = paint(clockTime(date), 'dim', 'gray');
  return message
    .split('\n')
    .map((line) => (line ? `${time} ${line}` : line))
    .join('\n');
}

/** A logger producing the CLI's console lines, written to any sink. */
export function createLogger(sink: LogSink, debugEnabled: boolean): Logger {
  let progressVisible = false;

  const clearProgress = () => {
    if (!progressVisible) {
      return;
    }

    sink.write?.('\r\x1b[2K\r');
    progressVisible = false;
  };

  return {
    info: (message) => {
      clearProgress();
      sink.out(withTimestamp(message));
    },
    warn: (message) => {
      clearProgress();
      sink.err(withTimestamp(message));
    },
    error: (message) => {
      clearProgress();
      sink.err(withTimestamp(message));
    },
    debug: (message, details) => {
      if (debugEnabled) {
        clearProgress();
        sink.out(withTimestamp(format(`${paint('[debug]', 'dim')} ${message}`, details ?? '')));
      }
    },
    progress: (message) => {
      if (!sink.write) {
        return;
      }

      sink.write(`\r\x1b[2K${fitProgressLine(message)}`);
      progressVisible = true;
    },
  };
}

export function createConsoleLogger(debugEnabled: boolean): Logger {
  return createLogger(
    {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      write: TRANSIENT_OUTPUT ? (text) => process.stdout.write(text) : undefined,
    },
    debugEnabled,
  );
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  progress: () => {},
};
