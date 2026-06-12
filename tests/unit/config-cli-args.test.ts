import { describe, it, expect } from 'vitest';
import { parseConfigArgs } from '../../src/config-cli.js';

describe('parseConfigArgs', () => {
  it('parses subcommand and positionals', () => {
    expect(parseConfigArgs(['config', 'set', 'a.b', '5'])).toEqual({
      sub: 'set', positionals: ['a.b', '5'], reveal: false
    });
  });
  it('extracts --reveal regardless of position', () => {
    expect(parseConfigArgs(['config', 'get', '--reveal', 'a.b'])).toEqual({
      sub: 'get', positionals: ['a.b'], reveal: true
    });
  });
  it('treats tokens after -- as literal positionals (negative value)', () => {
    expect(parseConfigArgs(['config', 'set', 'x', '--', '-0.5'])).toEqual({
      sub: 'set', positionals: ['x', '-0.5'], reveal: false
    });
  });
  it('does not activate reveal when --reveal follows --', () => {
    const r = parseConfigArgs(['config', 'get', 'x', '--', '--reveal']);
    expect(r.reveal).toBe(false);
    expect(r.positionals).toContain('--reveal');
  });
  it('returns empty sub when no subcommand given', () => {
    expect(parseConfigArgs(['config'])).toEqual({ sub: '', positionals: [], reveal: false });
  });
});
