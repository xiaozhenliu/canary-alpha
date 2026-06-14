import { describe, expect, it } from 'vitest';

describe('config file permission check logic', () => {
  function isWorldOrGroupReadable(mode: number): boolean {
    return (mode & 0o044) !== 0;
  }

  it('flags 0o644 as readable by others', () => {
    expect(isWorldOrGroupReadable(0o644)).toBe(true);
  });

  it('flags 0o640 as group-readable', () => {
    expect(isWorldOrGroupReadable(0o640)).toBe(true);
  });

  it('accepts 0o600 as private', () => {
    expect(isWorldOrGroupReadable(0o600)).toBe(false);
  });

  it('accepts 0o700 as private', () => {
    expect(isWorldOrGroupReadable(0o700)).toBe(false);
  });
});
