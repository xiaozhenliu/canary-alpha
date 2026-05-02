import { mkdir, stat, appendFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stderr } from 'node:process';

import type { LogLevel, Logger } from '../types/app-config.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const MAX_LOG_FILE_SIZE_BYTES = 1_000_000;
const pendingLogWrites = new Map<string, Promise<void>>();

function serializeMetadata(metadata?: Record<string, unknown>): string {
  if (!metadata || Object.keys(metadata).length === 0) {
    return '';
  }

  return ` ${JSON.stringify(metadata)}`;
}

function createLogLine(logLevel: LogLevel, message: string, metadata?: Record<string, unknown>): string {
  return `${new Date().toISOString()} [${logLevel.toUpperCase()}] ${message}${serializeMetadata(metadata)}`;
}

async function rotateLogFileIfNeeded(filePath: string): Promise<void> {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.size < MAX_LOG_FILE_SIZE_BYTES) {
      return;
    }

    await rename(filePath, `${filePath}.1`);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function writeToLogFile(filePath: string, line: string): Promise<void> {
  const previousWrite = pendingLogWrites.get(filePath) ?? Promise.resolve();
  const nextWrite = previousWrite
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      await rotateLogFileIfNeeded(filePath);
      await appendFile(filePath, `${line}\n`, 'utf8');
    });

  pendingLogWrites.set(filePath, nextWrite);

  try {
    await nextWrite;
  } finally {
    if (pendingLogWrites.get(filePath) === nextWrite) {
      pendingLogWrites.delete(filePath);
    }
  }
}

export function createLogger(level: LogLevel, options?: {
  filePath?: string;
  writeToStderr?: boolean;
}): Logger {
  const minimumLevel = LEVEL_ORDER[level];
  const filePath = options?.filePath;
  const writeToStderr = options?.writeToStderr ?? true;

  function write(logLevel: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    if (LEVEL_ORDER[logLevel] < minimumLevel) {
      return;
    }

    const line = createLogLine(logLevel, message, metadata);

    if (writeToStderr) {
      stderr.write(`${line}\n`);
    }

    if (filePath) {
      void writeToLogFile(filePath, line).catch((error) => {
        stderr.write(`${createLogLine('error', 'Failed to write log file', {
          message: error instanceof Error ? error.message : String(error),
          filePath
        })}\n`);
      });
    }
  }

  return {
    debug(message, metadata) {
      write('debug', message, metadata);
    },
    info(message, metadata) {
      write('info', message, metadata);
    },
    warn(message, metadata) {
      write('warn', message, metadata);
    },
    error(message, metadata) {
      write('error', message, metadata);
    }
  };
}
