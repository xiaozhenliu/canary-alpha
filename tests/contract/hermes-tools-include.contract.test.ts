import { describe, expect, it } from 'vitest';

import { TOOL_MANIFEST } from '../../src/mcp/tool-manifest.js';
import {
  PHASE4_TOOL_INCLUDES,
  V1_EVALS_TOOL_INCLUDES
} from '../../scripts/hermes-tool-includes.js';
import { V1_EVALS_FIXTURE_RECORDS } from '../../scripts/hermes-v1-fixture-records.js';
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

  it('every fixture-id-shaped requiredTranscriptTokens entry maps to a real fixture record', () => {
    const FIXTURE_ID_SHAPED = /^(?:eval-[a-z0-9-]+|9\d{3})$/;
    const knownIds = new Set<string>(V1_EVALS_FIXTURE_RECORDS.map((record) => record.id));
    const knownFrameIds = new Set<number>(V1_EVALS_FIXTURE_RECORDS.map((record) => record.frameId));

    const offending: Array<{ taskId: string; token: string; reason: string }> = [];
    for (const task of V1_EVALUATION_TASKS) {
      for (const token of task.requiredTranscriptTokens) {
        if (!FIXTURE_ID_SHAPED.test(token)) {
          continue;
        }
        if (/^eval-/.test(token)) {
          if (!knownIds.has(token)) {
            offending.push({
              taskId: task.id,
              token,
              reason: 'eval-* token does not match any fixture record id'
            });
          } else {
            // The bug: an eval-* record.id is not surfaced by find / recall
            // structured content. Only the fixture record's frameId is
            // surfaceable. So even when the eval-* string matches a record
            // id, the token is unreachable through the registered tool
            // surface and must instead be expressed as the matching frameId
            // substring (e.g. '9101').
            offending.push({
              taskId: task.id,
              token,
              reason:
                "eval-* record.id is not surfaced by find/recall structured content; assert on the matching frameId substring instead (e.g. '9101')"
            });
          }
          continue;
        }
        // 9NNN numeric form must equal some record.frameId.
        if (!knownFrameIds.has(Number(token))) {
          offending.push({
            taskId: task.id,
            token,
            reason: '9NNN token does not match any fixture record frameId'
          });
        }
      }
    }

    const availablePairs = V1_EVALS_FIXTURE_RECORDS.map((record) => ({
      id: record.id,
      frameId: record.frameId
    }));
    expect(
      offending,
      `V1_EVALUATION_TASKS requiredTranscriptTokens contain fixture-id-shaped tokens that do not map to a real fixture record. Offending: ${JSON.stringify(offending)}. Available fixture id/frameId pairs: ${JSON.stringify(availablePairs)}.`
    ).toEqual([]);
  });

  it('every recall-using prompt in the four affected tasks anchors via explicit ISO from/to', () => {
    // retrieval-summary and failure-recovery use `find` (not `recall`), so
    // they are excluded from this clock-anchor check. Only the two
    // recall-using affected tasks must contain the explicit ISO from/to
    // anchored at FIXTURE_NOW = 2026-04-13T12:00:00.000Z.
    const RECALL_USING_AFFECTED_TASK_IDS = new Set<string>([
      'status-and-recent-activity',
      'find-then-refine'
    ]);
    const FROM_ANCHOR_PREFIX = 'from "2026-04-13T';
    const TO_ANCHOR_LITERAL = 'to "2026-04-13T12:00:00.000Z"';

    const offending: Array<{ taskId: string; query: string; missing: string[] }> = [];
    for (const task of V1_EVALUATION_TASKS) {
      if (!RECALL_USING_AFFECTED_TASK_IDS.has(task.id)) {
        continue;
      }
      const missing: string[] = [];
      if (!task.query.includes(FROM_ANCHOR_PREFIX)) {
        missing.push(FROM_ANCHOR_PREFIX);
      }
      if (!task.query.includes(TO_ANCHOR_LITERAL)) {
        missing.push(TO_ANCHOR_LITERAL);
      }
      if (missing.length > 0) {
        offending.push({ taskId: task.id, query: task.query, missing });
      }
    }

    expect(
      offending,
      `V1_EVALUATION_TASKS recall-using prompts in the four affected tasks must anchor the recall window via explicit ISO from/to. Offending: ${JSON.stringify(offending)}.`
    ).toEqual([]);
  });
});
