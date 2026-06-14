import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../../src/services/work-activity/summary/remote-llm.js';

describe('redactSecrets', () => {
  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc';
    expect(redactSecrets(input)).toBe('Authorization: Bearer [REDACTED]');
  });

  it('redacts OpenAI API keys', () => {
    const input = 'export OPENAI_API_KEY=sk-abcdefghij1234567890abcdefghij1234567890';
    expect(redactSecrets(input)).toContain('[REDACTED_API_KEY]');
    expect(redactSecrets(input)).not.toContain('sk-abcdefghij');
  });

  it('redacts GitHub personal access tokens', () => {
    const input = 'git clone https://ghp_abcdefghijklmnopqrstuvwxyz1234567890@github.com/repo';
    expect(redactSecrets(input)).toContain('[REDACTED_GH_TOKEN]');
    expect(redactSecrets(input)).not.toContain('ghp_');
  });

  it('redacts AWS access keys', () => {
    const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    expect(redactSecrets(input)).toContain('[REDACTED_AWS_KEY]');
  });

  it('redacts Slack tokens', () => {
    const input = 'SLACK_TOKEN=xoxb-123456-abcdef-ghijkl';
    expect(redactSecrets(input)).toContain('[REDACTED_SLACK_TOKEN]');
  });

  it('preserves normal text', () => {
    const input = 'User opened VS Code and typed class Skeleton {}';
    expect(redactSecrets(input)).toBe(input);
  });

  it('handles multiple secrets in one string', () => {
    const input = 'key=sk-abc12345678901234567890 token=ghp_xyz123456789012345678901234567890123';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_API_KEY]');
    expect(result).toContain('[REDACTED_GH_TOKEN]');
  });
});
