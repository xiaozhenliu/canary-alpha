import type { McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../types/app-config.js';
import { registerFileAnalyzeTool } from './tools/file-analyze.js';
import { registerFindTool } from './tools/find.js';
import { registerInspectTool } from './tools/inspect.js';
import { registerInternalStatusTool } from './tools/internal/status.js';
import { registerMemoryReadTool } from './tools/memory-read.js';
import { registerMemoryWriteTool } from './tools/memory-write.js';
import { registerPrivacyControlTool } from './tools/privacy-control.js';
import { registerRecallTool } from './tools/recall.js';
import { registerRoutineCreateTool } from './tools/routine-create.js';
import { registerRoutineHistoryTool } from './tools/routine-history.js';
import { registerRoutineListTool } from './tools/routine-list.js';
import { registerScreenpipeControlTool } from './tools/screenpipe-control.js';

export function registerTools(server: McpServer, app: AppContext): void {
  // Work-activity-analysis tools (task 8.1 skeleton; full implementations
  // land in 8.2 / 8.3 / 8.4 / 8.5). The legacy `search-screen` /
  // `recent-activity` registrations were removed in task 8.1 — `find` /
  // `recall` / `inspect` are their forward replacements.
  registerFindTool(server, app);
  registerRecallTool(server, app);
  registerInspectTool(server, app);
  registerMemoryReadTool(server, app);
  registerMemoryWriteTool(server, app);
  registerFileAnalyzeTool(server, app);
  registerPrivacyControlTool(server, app);
  registerScreenpipeControlTool(server, app);
  registerInternalStatusTool(server, app);
  // Routines tools (ROUT-01 / ROUT-02 / ROUT-03).
  registerRoutineListTool(server, app);
  registerRoutineCreateTool(server, app);
  registerRoutineHistoryTool(server, app);
}
