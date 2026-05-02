export const TOOL_MANIFEST = [
  {
    name: 'search-screen',
    title: 'Search Screen History',
    category: 'retrieval'
  },
  {
    name: 'recent-activity',
    title: 'Recent Activity',
    category: 'retrieval'
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
