export const TOOL_MANIFEST = [
  {
    name: 'find',
    title: 'Find Evidence',
    category: 'work-activity'
  },
  {
    name: 'recall',
    title: 'Recall Time Window',
    category: 'work-activity'
  },
  {
    name: 'inspect',
    title: 'Inspect Session or Frame',
    category: 'work-activity'
  },
  {
    name: 'memory-read',
    title: 'Read Memory',
    category: 'memory'
  },
  {
    name: 'memory-write',
    title: 'Write Memory',
    category: 'memory'
  },
  {
    name: 'file-analyze',
    title: 'Analyze File',
    category: 'file-analysis'
  },
  {
    name: 'privacy-control',
    title: 'Privacy Control',
    category: 'privacy'
  },
  {
    name: 'internal-status',
    title: 'Internal Status',
    category: 'internal'
  }
] as const;

export type ToolManifestEntry = (typeof TOOL_MANIFEST)[number];
export type ToolName = ToolManifestEntry['name'];
