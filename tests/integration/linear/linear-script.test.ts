import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  parseCliArgs,
  parseLinearProjectUrl,
  parseSimpleEnv,
  readLinearEnv
} from '../../../scripts/linear.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const task = cleanup.pop();
    if (task) {
      await task();
    }
  }
});

describe('linear script helpers', () => {
  it('parses a minimal env file for Linear settings', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'linear-env-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const envPath = join(homeDir, '.env');
    await writeFile(envPath, [
      '# comment',
      'LINEAR_API_KEY=test-key',
      'LINEAR_PROJECT_URL=https://linear.app/growthrocketstudio/project/computer-history-ce2d10661599/overview'
    ].join('\n'), 'utf8');

    await expect(readLinearEnv(envPath)).resolves.toEqual({
      apiKey: 'test-key',
      projectUrl: 'https://linear.app/growthrocketstudio/project/computer-history-ce2d10661599/overview'
    });
  });

  it('parses quoted env values and ignores comments', () => {
    expect(parseSimpleEnv([
      '# comment',
      'LINEAR_API_KEY="quoted-key"',
      'LINEAR_PROJECT_URL=https://linear.app/acme/project/demo-123/overview'
    ].join('\n'))).toEqual({
      LINEAR_API_KEY: 'quoted-key',
      LINEAR_PROJECT_URL: 'https://linear.app/acme/project/demo-123/overview'
    });
  });

  it('extracts workspace and project slug from the configured project url', () => {
    expect(parseLinearProjectUrl('https://linear.app/growthrocketstudio/project/computer-history-ce2d10661599/overview')).toEqual({
      workspaceSlug: 'growthrocketstudio',
      projectSlug: 'computer-history-ce2d10661599'
    });
  });

  it('rejects malformed project urls', () => {
    expect(() => parseLinearProjectUrl('https://example.com/not-linear')).toThrow('LINEAR_PROJECT_URL must point at linear.app');
  });

  it('parses list, create, update-status, update-description, assign, comment, update-labels, and delete arguments', () => {
    expect(parseCliArgs(['list'])).toEqual({ kind: 'list' });
    expect(parseCliArgs(['create', '--title', 'Fix onboarding', '--description', 'Details'])).toEqual({
      kind: 'create',
      title: 'Fix onboarding',
      description: 'Details',
      labels: []
    });
    expect(parseCliArgs(['create', '--title', 'Fix onboarding', '--label', 'Feature', '--label', 'bug', '--label', 'feature'])).toEqual({
      kind: 'create',
      title: 'Fix onboarding',
      labels: ['feature', 'bug']
    });
    expect(parseCliArgs(['update-status', '--issue', 'CAN-123', '--status', 'In Progress'])).toEqual({
      kind: 'update-status',
      issue: 'CAN-123',
      status: 'In Progress'
    });
    expect(parseCliArgs(['update-description', '--issue', 'CAN-123', '--description', 'Corrected scope'])).toEqual({
      kind: 'update-description',
      issue: 'CAN-123',
      description: 'Corrected scope'
    });
    expect(parseCliArgs(['assign', '--issue', 'CAN-123', '--assignee', 'me'])).toEqual({
      kind: 'assign',
      issue: 'CAN-123',
      assignee: 'me'
    });
    expect(parseCliArgs(['comment', '--issue', 'CAN-123', '--body', 'Looks good'])).toEqual({
      kind: 'comment',
      issue: 'CAN-123',
      body: 'Looks good'
    });
    expect(parseCliArgs(['update-labels', '--issue', 'CAN-123', '--label', 'safety', '--label', 'bug'])).toEqual({
      kind: 'update-labels',
      issue: 'CAN-123',
      labels: ['safety', 'bug']
    });
    expect(parseCliArgs(['delete', '--issue', 'CAN-123'])).toEqual({
      kind: 'delete',
      issue: 'CAN-123'
    });
  });

  it('rejects unsupported update statuses', () => {
    expect(() => parseCliArgs(['update-status', '--issue', 'CAN-123', '--status', 'Blocked'])).toThrow('Unsupported status');
  });

  it('rejects unsupported labels', () => {
    expect(() => parseCliArgs(['create', '--title', 'Fix onboarding', '--label', 'docs'])).toThrow('Unsupported label');
  });

  it('requires description for update-description', () => {
    expect(() => parseCliArgs(['update-description', '--issue', 'CAN-123'])).toThrow('Missing required --description for update-description.');
  });

  it('requires assignee for assign', () => {
    expect(() => parseCliArgs(['assign', '--issue', 'CAN-123'])).toThrow('Missing required --assignee for assign.');
  });

  it('requires body for comment', () => {
    expect(() => parseCliArgs(['comment', '--issue', 'CAN-123'])).toThrow('Missing required --body for comment.');
  });

  it('requires at least one label for update-labels', () => {
    expect(() => parseCliArgs(['update-labels', '--issue', 'CAN-123'])).toThrow('Missing required --label for update-labels.');
  });
});
