import type { CaptureRecord } from './types.js';
import type { Logger } from '../../types/app-config.js';

/**
 * Strip records whose AX role is in secureAxRoles, plus all their descendants
 * within the same frame (R4.4).
 *
 * Grouping is done per frameId. Within each frame, the function builds a
 * parent→children map using `parentId` (preferred) or `path` (fallback).
 *
 * Degraded mode (no parentId / path available): only the secure-role record
 * itself is filtered; subtree pruning is skipped and a debug log is emitted.
 */
export function stripSecureAxSubtrees(
  records: CaptureRecord[],
  secureAxRoles: string[],
  logger?: Logger
): CaptureRecord[] {
  if (secureAxRoles.length === 0) {
    return records;
  }

  const secureRoleSet = new Set(secureAxRoles.map((r) => r.toLowerCase()));

  function isSecureRole(record: CaptureRecord): boolean {
    return record.role !== undefined && secureRoleSet.has(record.role.toLowerCase());
  }

  // Group records by frameId (undefined frameId → each record is its own group)
  const byFrame = new Map<string, CaptureRecord[]>();
  for (const record of records) {
    const key = record.frameId !== undefined ? `frame:${record.frameId}` : `id:${record.id}`;
    const group = byFrame.get(key);
    if (group) {
      group.push(record);
    } else {
      byFrame.set(key, [record]);
    }
  }

  const filtered: CaptureRecord[] = [];

  for (const group of byFrame.values()) {
    // Check if any record in this group has parentId or path for tree traversal
    const hasTreeInfo = group.some((r) => r.parentId !== undefined || r.path !== undefined);

    const secureRecords = group.filter(isSecureRole);
    if (secureRecords.length === 0) {
      // No secure records in this group — keep all
      filtered.push(...group);
      continue;
    }

    if (!hasTreeInfo) {
      // Degraded mode: only filter the secure-role records themselves
      logger?.debug('secureAxRoles: subtree pruning disabled, parent_id missing');
      filtered.push(...group.filter((r) => !isSecureRole(r)));
      continue;
    }

    // Full subtree pruning mode
    // Build id → record map and parent → children map
    const byId = new Map<string, CaptureRecord>();
    for (const r of group) {
      byId.set(r.id, r);
    }

    // Build children map using parentId
    const children = new Map<string, Set<string>>();
    for (const r of group) {
      if (r.parentId !== undefined) {
        let childSet = children.get(r.parentId);
        if (!childSet) {
          childSet = new Set();
          children.set(r.parentId, childSet);
        }
        childSet.add(r.id);
      }
    }

    // If parentId is not available but path is, build children map from path
    // path format: '0.1.2' — a record's parent has path '0.1'
    if (!group.some((r) => r.parentId !== undefined) && group.some((r) => r.path !== undefined)) {
      for (const r of group) {
        if (r.path === undefined) continue;
        const parts = r.path.split('.');
        if (parts.length > 1) {
          const parentPath = parts.slice(0, -1).join('.');
          // Find the record with this parent path
          for (const candidate of group) {
            if (candidate.path === parentPath) {
              let childSet = children.get(candidate.id);
              if (!childSet) {
                childSet = new Set();
                children.set(candidate.id, childSet);
              }
              childSet.add(r.id);
              break;
            }
          }
        }
      }
    }

    // BFS/DFS to collect all descendants of secure records
    const blockedIds = new Set<string>();
    const queue: string[] = [];

    for (const secureRecord of secureRecords) {
      blockedIds.add(secureRecord.id);
      queue.push(secureRecord.id);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      const childIds = children.get(current);
      if (childIds) {
        for (const childId of childIds) {
          if (!blockedIds.has(childId)) {
            blockedIds.add(childId);
            queue.push(childId);
          }
        }
      }
    }

    filtered.push(...group.filter((r) => !blockedIds.has(r.id)));
  }

  return filtered;
}

/**
 * Remove secure-role nodes from a serialized nested AX tree before any
 * extraction rule can inspect it. This complements the flat-record pruning
 * above, which cannot see descendants embedded in `accessibilityTreeJson`.
 */
export function stripSecureAxTreeJson(
  treeJson: string | null,
  secureAxRoles: string[]
): string | null {
  if (treeJson === null || secureAxRoles.length === 0) {
    return treeJson;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(treeJson);
  } catch {
    return treeJson;
  }

  const secureRoleSet = new Set(secureAxRoles.map((role) => role.toLowerCase()));

  function prune(value: unknown): unknown {
    if (Array.isArray(value)) {
      if (isFlatAccessibilityArray(value)) {
        return pruneFlatAccessibilityArray(value, secureRoleSet);
      }
      return value
        .map((item) => prune(item))
        .filter((item) => item !== undefined);
    }
    if (value === null || typeof value !== 'object') {
      return value;
    }

    const node = value as Record<string, unknown>;
    const role = node.role;
    if (typeof role === 'string' && secureRoleSet.has(role.toLowerCase())) {
      return undefined;
    }

    const copy: Record<string, unknown> = { ...node };
    if (Array.isArray(copy.children)) {
      copy.children = prune(copy.children);
    }
    return copy;
  }

  const sanitized = prune(parsed);
  if (sanitized === undefined) return null;
  return JSON.stringify(sanitized);
}

function isFlatAccessibilityArray(
  value: unknown[]
): value is Array<Record<string, unknown>> {
  const objectItems = value.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
  );
  return (
    objectItems.length > 0 &&
    objectItems.length === value.length &&
    objectItems.some((item) => 'depth' in item)
  );
}

/**
 * Removes secure nodes and their preorder descendants from Screenpipe's
 * flat depth representation before it can be rebuilt into a nested tree.
 */
function pruneFlatAccessibilityArray(
  value: Array<Record<string, unknown>>,
  secureRoleSet: ReadonlySet<string>
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  let secureDepth: number | null = null;

  for (const item of value) {
    const rawDepth = item.depth;
    const depth =
      typeof rawDepth === 'number' && Number.isFinite(rawDepth)
        ? Math.max(0, Math.floor(rawDepth))
        : null;

    if (secureDepth !== null) {
      // An invalid depth cannot prove that this row is outside the secure
      // subtree, so keep skipping until a reliable boundary is observed.
      if (depth === null || depth > secureDepth) continue;
      secureDepth = null;
    }

    const role = item.role;
    if (typeof role === 'string' && secureRoleSet.has(role.toLowerCase())) {
      // Treat an invalid secure-node depth as the shallowest possible node;
      // this may over-filter, but it cannot expose a descendant.
      secureDepth = depth ?? 0;
      continue;
    }

    result.push(item);
  }

  return result;
}
