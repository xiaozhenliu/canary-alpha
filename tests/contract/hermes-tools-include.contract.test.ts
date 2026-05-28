import { describe, expect, it } from 'vitest';

import { TOOL_MANIFEST } from '../../src/mcp/tool-manifest.js';
import {
  PHASE4_TOOL_INCLUDES,
  V1_EVALS_TOOL_INCLUDES
} from '../../scripts/hermes-tool-includes.js';
import { V1_EVALUATION_TASKS } from '../evaluations/v1-evaluation-manifest.js';

const REGISTERED_TOOL_NAMES = new Set<string>(TOOL_MANIFEST.map((tool) => tool.name));
const V1_EVALS_MARKER_PREFIX = 'preparing mcp_screenpipe_memory_v1_evals_';

function recoverToolNameFromMarker(marker: string): string | null {
  if (!marker.startsWith(V1_EVALS_MARKER_PREFIX)) {
    return null;
  }
  const suffix = marker.slice(V1_EVALS_MARKER_PREFIX.length);
  return suffix.replace(/_/g, '-');
}

describe('hermes-side tools.include drift contract', () => {
  it('every entry of PHASE4_TOOL_INCLUDES is registered in TOOL_MANIFEST', () => {
    const offending = PHASE4_TOOL_INCLUDES.filter((entry) => !REGISTERED_TOOL_NAMES.has(entry));
    expect(
      offending,
      `PHASE4_TOOL_INCLUDES entries not registered in TOOL_MANIFEST: ${JSON.stringify(offending)}`
    ).toEqual([]);
  });

  it('every entry of V1_EVALS_TOOL_INCLUDES is registered in TOOL_MANIFEST', () => {
    const offending = V1_EVALS_TOOL_INCLUDES.filter((entry) => !REGISTERED_TOOL_NAMES.has(entry));
    expect(
      offending,
      `V1_EVALS_TOOL_INCLUDES entries not registered in TOOL_MANIFEST: ${JSON.stringify(offending)}`
    ).toEqual([]);
  });

  it('every V1_EVALUATION_TASKS requiredToolMarkers entry maps to a registered tool', () => {
    const offending: Array<{ taskId: string; marker: string; recovered: string | null }> = [];
    for (const task of V1_EVALUATION_TASKS) {
      for (const marker of task.requiredToolMarkers) {
        const recovered = recoverToolNameFromMarker(marker);
        if (recovered === null || !REGISTERED_TOOL_NAMES.has(recovered)) {
          offending.push({ taskId: task.id, marker, recovered });
        }
      }
    }
    expect(
      offending,
      `V1_EVALUATION_TASKS requiredToolMarkers referencing non-registered tools: ${JSON.stringify(offending)}`
    ).toEqual([]);
  });

  it('both Hermes-side tools.include arrays are non-empty and contain internal-status', () => {
    expect(PHASE4_TOOL_INCLUDES.length, 'PHASE4_TOOL_INCLUDES must be non-empty').toBeGreaterThan(0);
    expect(V1_EVALS_TOOL_INCLUDES.length, 'V1_EVALS_TOOL_INCLUDES must be non-empty').toBeGreaterThan(0);
    expect(
      PHASE4_TOOL_INCLUDES.includes('internal-status'),
      'PHASE4_TOOL_INCLUDES must contain "internal-status"'
    ).toBe(true);
    expect(
      V1_EVALS_TOOL_INCLUDES.includes('internal-status'),
      'V1_EVALS_TOOL_INCLUDES must contain "internal-status"'
    ).toBe(true);
  });
});
