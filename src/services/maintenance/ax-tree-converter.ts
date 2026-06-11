interface RawNode {
  role?: unknown;
  text?: unknown;
  depth?: unknown;
  bounds?: { left?: unknown; top?: unknown; width?: unknown; height?: unknown };
  on_screen?: unknown;
  [extra: string]: unknown;
}

export interface ConvertedRow {
  role: string;
  text: string | null;
  depth: number;
  sortOrder: number;
  parentIndex: number | null;
  bounds: { left: number; top: number; width: number; height: number } | null;
  onScreen: 0 | 1 | null;
  properties: string | null;
}

const CORE_KEYS = new Set(['role', 'text', 'depth', 'bounds', 'on_screen']);

export function convertTreeJson(treeJson: string): ConvertedRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(treeJson);
  } catch (cause) {
    throw new Error(`ConvertError: invalid JSON (${(cause as Error).message})`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('ConvertError: tree json is not a flat array');
  }

  const rows: ConvertedRow[] = [];
  const lastIndexAtDepth = new Map<number, number>();

  parsed.forEach((node: RawNode, index) => {
    const depth = typeof node.depth === 'number' && Number.isFinite(node.depth) ? node.depth : 0;
    const parentIndex = depth > 0 ? (lastIndexAtDepth.get(depth - 1) ?? null) : null;
    lastIndexAtDepth.set(depth, index);

    const rawBounds = node.bounds;
    const bounds =
      rawBounds &&
      typeof rawBounds.left === 'number' &&
      typeof rawBounds.top === 'number' &&
      typeof rawBounds.width === 'number' &&
      typeof rawBounds.height === 'number'
        ? {
            left: rawBounds.left,
            top: rawBounds.top,
            width: rawBounds.width,
            height: rawBounds.height
          }
        : null;

    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (!CORE_KEYS.has(key) && value !== undefined) {
        properties[key] = value;
      }
    }
    properties._converted_by = 'maintenance';

    rows.push({
      role: typeof node.role === 'string' ? node.role : 'AXUnknown',
      text: typeof node.text === 'string' ? node.text : null,
      depth,
      sortOrder: index,
      parentIndex,
      bounds,
      onScreen: typeof node.on_screen === 'boolean' ? (node.on_screen ? 1 : 0) : null,
      properties: JSON.stringify(properties)
    });
  });

  return rows;
}
