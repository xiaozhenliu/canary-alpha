import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type MeasuredPath = {
  bytes: number;
  exists: boolean;
};

export async function computePathBytes(targetPath: string): Promise<MeasuredPath> {
  try {
    const targetStats = await stat(targetPath);
    if (targetStats.isFile()) {
      return {
        bytes: targetStats.size,
        exists: true
      };
    }

    if (!targetStats.isDirectory()) {
      return {
        bytes: 0,
        exists: true
      };
    }

    const entries = await readdir(targetPath, { withFileTypes: true });
    let totalBytes = 0;

    for (const entry of entries) {
      const childPath = join(targetPath, entry.name);
      const childMeasurement = await computePathBytes(childPath);
      totalBytes += childMeasurement.bytes;
    }

    return {
      bytes: totalBytes,
      exists: true
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return {
        bytes: 0,
        exists: false
      };
    }

    throw error;
  }
}

export async function computeAggregateBytes(paths: string[]): Promise<MeasuredPath> {
  let totalBytes = 0;
  let exists = false;

  for (const targetPath of paths) {
    const measurement = await computePathBytes(targetPath);
    totalBytes += measurement.bytes;
    exists ||= measurement.exists;
  }

  return {
    bytes: totalBytes,
    exists
  };
}

export async function computeScreenpipeLogBytes(screenpipeDirectory: string): Promise<MeasuredPath> {
  try {
    const entries = await readdir(screenpipeDirectory, { withFileTypes: true });
    const logPaths = entries
      .filter((entry) => entry.isFile() && /^screenpipe\..+\.log$/u.test(entry.name))
      .map((entry) => join(screenpipeDirectory, entry.name));

    return computeAggregateBytes(logPaths);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return {
        bytes: 0,
        exists: false
      };
    }

    throw error;
  }
}
