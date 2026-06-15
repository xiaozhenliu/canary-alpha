import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTailLines } from '../../../src/dashboard/routes/logs.js';

describe('readTailLines', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `logs-tail-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns [] for a missing file (ENOENT)', async () => {
    const result = await readTailLines(join(dir, 'nonexistent.log'), 100);
    expect(result).toEqual([]);
  });

  it('returns [] for an empty file', async () => {
    const filePath = join(dir, 'empty.log');
    await writeFile(filePath, '');
    const result = await readTailLines(filePath, 100);
    expect(result).toEqual([]);
  });

  it('returns all lines when file has fewer lines than requested', async () => {
    const filePath = join(dir, 'small.log');
    const lines = ['line1', 'line2', 'line3'];
    await writeFile(filePath, lines.join('\n') + '\n');
    const result = await readTailLines(filePath, 100);
    expect(result).toEqual(lines);
  });

  it('returns exactly maxLines from the tail when file has more', async () => {
    const filePath = join(dir, 'big.log');
    const lines = Array.from({ length: 50 }, (_, i) => `log entry ${i + 1}`);
    await writeFile(filePath, lines.join('\n') + '\n');
    const result = await readTailLines(filePath, 10);
    // Should get the last 10 lines
    expect(result).toHaveLength(10);
    expect(result[0]).toBe('log entry 41');
    expect(result[9]).toBe('log entry 50');
  });

  it('skips empty/blank lines', async () => {
    const filePath = join(dir, 'blank.log');
    await writeFile(filePath, 'line1\n\n  \nline2\nline3\n');
    const result = await readTailLines(filePath, 100);
    expect(result).toEqual(['line1', 'line2', 'line3']);
  });

  it('returns lines in forward order', async () => {
    const filePath = join(dir, 'order.log');
    const lines = ['first', 'second', 'third'];
    await writeFile(filePath, lines.join('\n'));
    const result = await readTailLines(filePath, 100);
    expect(result).toEqual(['first', 'second', 'third']);
  });

  it('handles a large file (>64KB chunk) and returns only the tail', async () => {
    const filePath = join(dir, 'large.log');
    // Create more than 64KB of content to force multiple chunk reads
    const lines = Array.from({ length: 5000 }, (_, i) => `{"level":"info","msg":"entry ${i + 1}"}`);
    await writeFile(filePath, lines.join('\n') + '\n');
    const result = await readTailLines(filePath, 20);
    expect(result).toHaveLength(20);
    // Last line should be entry 5000
    expect(result[result.length - 1]).toContain('entry 5000');
    // First line in result should be entry 4981
    expect(result[0]).toContain('entry 4981');
  });

  it('handles a file with no trailing newline', async () => {
    const filePath = join(dir, 'no-newline.log');
    await writeFile(filePath, 'lineA\nlineB\nlineC');
    const result = await readTailLines(filePath, 100);
    expect(result).toEqual(['lineA', 'lineB', 'lineC']);
  });
});
