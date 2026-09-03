export const TOOL_MANIFEST = [
  {
    name: 'find',
    title: 'Find in Screen Memory',
    category: 'work-activity'
  },
  {
    name: 'recall',
    title: 'Recall Screen Activity',
    category: 'work-activity'
  },
  {
    name: 'inspect',
    title: 'Inspect Screen Session or Frame',
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
  },
  {
    name: 'routine-list',
    title: 'List Routines',
    category: 'routines'
  },
  {
    name: 'routine-create',
    title: 'Create or Update Routine',
    category: 'routines'
  },
  {
    name: 'routine-history',
    title: 'Routine Execution History',
    category: 'routines'
  },
  {
    name: 'screenpipe-control',
    title: 'Screenpipe Control',
    category: 'screenpipe'
  }
] as const;

export type ToolManifestEntry = (typeof TOOL_MANIFEST)[number];
export type ToolName = ToolManifestEntry['name'];
