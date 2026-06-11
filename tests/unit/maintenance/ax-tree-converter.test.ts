import { describe, expect, it } from 'vitest';

import { convertTreeJson } from '../../../src/services/maintenance/ax-tree-converter.js';
import { syntheticTree } from '../../helpers/maintenance-fixture.js';

describe('convertTreeJson', () => {
  const json = JSON.stringify(syntheticTree());

  it('emits one row per JSON node and preserves sort order', () => {
    const rows = convertTreeJson(json);
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.sortOrder)).toEqual([0, 1, 2, 3, 4]);
    expect(rows[0]).toMatchObject({ role: 'AXWindow', text: 'Demo Window', depth: 0 });
  });

  it('rebuilds parent chain from depth and preorder', () => {
    const rows = convertTreeJson(json);
    expect(rows[0].parentIndex).toBeNull();
    expect(rows[1].parentIndex).toBe(0);
    expect(rows[2].parentIndex).toBe(1);
    expect(rows[3].parentIndex).toBe(1);
    expect(rows[4].parentIndex).toBe(0);
  });

  it('packs extra fields into properties without duplicating core fields', () => {
    const rows = convertTreeJson(json);
    expect(JSON.parse(rows[1].properties!)).toEqual({
      role_description: 'heading',
      is_enabled: true,
      is_focused: false,
      _converted_by: 'maintenance'
    });
    expect(JSON.parse(rows[2].properties!)).toEqual({ _converted_by: 'maintenance' });
  });

  it('keeps bounds optional', () => {
    const rows = convertTreeJson(json);
    expect(rows[4].bounds).toBeNull();
    expect(rows[1].bounds).toEqual({ left: 0.1, top: 0.1, width: 0.5, height: 0.05 });
  });

  it('maps on_screen boolean to 0/1 and leaves missing values null', () => {
    const rows = convertTreeJson(json);
    expect(rows[0].onScreen).toBe(1);
    expect(rows[4].onScreen).toBeNull();
  });

  it('throws ConvertError for invalid JSON and non-array JSON', () => {
    expect(() => convertTreeJson('not json')).toThrowError(/ConvertError/);
    expect(() => convertTreeJson('{"a":1}')).toThrowError(/ConvertError/);
  });
});
