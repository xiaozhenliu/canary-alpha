import { describe, expect, it } from 'vitest';

import { buildCaptureId, parseCaptureId } from '../../src/services/capture/types.js';

describe('buildCaptureId', () => {
  it('uses frame form when frameId is present', () => {
    expect(buildCaptureId('screenpipe', { frameId: 123, id: 'frame:123:0' }))
      .toBe('screenpipe:frame:123');
  });

  it('falls back to rec form when frameId is absent', () => {
    expect(buildCaptureId('screenpipe', { id: 'abc-1' })).toBe('screenpipe:rec:abc-1');
  });

  it('treats frameId 0 as a valid frame id', () => {
    expect(buildCaptureId('screenpipe', { frameId: 0, id: 'x' })).toBe('screenpipe:frame:0');
  });
});

describe('parseCaptureId', () => {
  it('round-trips the frame form', () => {
    expect(parseCaptureId('screenpipe:frame:123'))
      .toEqual({ providerName: 'screenpipe', kind: 'frame', value: '123' });
  });

  it('round-trips the rec form', () => {
    expect(parseCaptureId('axtool:rec:abc-1'))
      .toEqual({ providerName: 'axtool', kind: 'rec', value: 'abc-1' });
  });

  it('returns null for legacy bare frame ids', () => {
    expect(parseCaptureId('12345')).toBeNull();
  });
});
