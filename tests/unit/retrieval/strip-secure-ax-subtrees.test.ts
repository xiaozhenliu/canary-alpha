import { describe, expect, it } from 'vitest';

import { stripSecureAxTreeJson } from '../../../src/services/retrieval/strip-secure-ax-subtrees.js';

describe('stripSecureAxTreeJson', () => {
  it('removes descendants of secure nodes in a flat depth array', () => {
    const tree = [
      { role: 'AXWindow', text: 'Password Manager', depth: 0 },
      { role: 'AXGroup', depth: 1 },
      { role: 'AXSecureTextField', depth: 2, value: 'secret' },
      { role: 'AXStaticText', depth: 3, value: 'secret child' },
      { role: 'AXButton', depth: 2, title: 'Cancel' },
      { role: 'AXStaticText', depth: 1, value: 'Public note' }
    ];

    const sanitized = JSON.parse(
      stripSecureAxTreeJson(JSON.stringify(tree), ['AXSecureTextField']) ?? 'null'
    ) as Array<Record<string, unknown>>;

    expect(sanitized).toEqual([
      { role: 'AXWindow', text: 'Password Manager', depth: 0 },
      { role: 'AXGroup', depth: 1 },
      { role: 'AXButton', depth: 2, title: 'Cancel' },
      { role: 'AXStaticText', depth: 1, value: 'Public note' }
    ]);
  });
});
