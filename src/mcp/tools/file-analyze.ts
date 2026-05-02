import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../../types/app-config.js';
import { formatFileAnalyzeToolResult } from './shared.js';

const inputSchema = z.object({
  path: z.string().min(1),
  question: z.string().optional()
});

export function registerFileAnalyzeTool(server: McpServer, app: AppContext): void {
  server.registerTool(
    'file-analyze',
    {
      title: 'Analyze File',
      description: 'Analyze a supported local file and summarize or answer a targeted question.',
      inputSchema
    },
    async (input) => {
      const result = await app.services.fileAnalysis.analyze(input);
      return formatFileAnalyzeToolResult(result);
    }
  );
}
