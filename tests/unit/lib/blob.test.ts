import { describe, it, expect } from 'vitest';
import { blobToFloat32Array, float32ArrayToBlob } from '../../../src/lib/blob.js';

describe('blob utilities', () => {
  it('round-trips embedding through Float32 BLOB', () => {
    const original = [0.1, 0.2, 0.3, 0.4, 0.5];
    const blob = float32ArrayToBlob(original);
    const result = blobToFloat32Array(new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength));
    const expected = Array.from(new Float32Array(original));
    expect(result).toEqual(expected);
  });

  it('handles empty embedding', () => {
    const blob = float32ArrayToBlob([]);
    const result = blobToFloat32Array(new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength));
    expect(result).toEqual([]);
  });

  it('throws on non-4-byte-aligned BLOB', () => {
    const bad = new Uint8Array(5);
    expect(() => blobToFloat32Array(bad)).toThrow('not a multiple of 4');
  });

  it('handles misaligned byteOffset', () => {
    const original = [1.0, 2.0, 3.0];
    const blob = float32ArrayToBlob(original);
    // Simulate misaligned buffer: create a buffer with 1-byte prefix
    const padded = new Uint8Array(blob.byteLength + 1);
    padded.set(new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength), 1);
    const misaligned = new Uint8Array(padded.buffer, 1, blob.byteLength);
    expect(misaligned.byteOffset % 4).not.toBe(0);
    const result = blobToFloat32Array(misaligned);
    const expected = Array.from(new Float32Array(original));
    expect(result).toEqual(expected);
  });
});
