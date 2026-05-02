import type { McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../types/app-config.js';
import { registerFileAnalyzeTool } from './tools/file-analyze.js';
import { registerInternalStatusTool } from './tools/internal/status.js';
import { registerMemoryReadTool } from './tools/memory-read.js';
import { registerMemoryWriteTool } from './tools/memory-write.js';
import { registerPrivacyControlTool } from './tools/privacy-control.js';
import { registerScreenpipeControlTool } from './tools/screenpipe-control.js';
import { registerRecentActivityTool } from './tools/recent-activity.js';
import { registerSearchScreenTool } from './tools/search-screen.js';

export function registerTools(server: McpServer, app: AppContext): void {
  registerSearchScreenTool(server, app);
  registerRecentActivityTool(server, app);
  registerMemoryReadTool(server, app);
  registerMemoryWriteTool(server, app);
  registerFileAnalyzeTool(server, app);
  registerPrivacyControlTool(server, app);
  registerScreenpipeControlTool(server, app);
  registerInternalStatusTool(server, app);
}
