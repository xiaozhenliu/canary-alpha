import type { CallToolResult } from '@modelcontextprotocol/server';

import type {
  FileAnalyzeResult
} from '../../services/file-analysis/types.js';
import type {
  MemoryReadResult,
  MemoryWriteResult
} from '../../services/memory/types.js';
import type {
  PrivacyControlResult
} from '../../services/privacy/types.js';

export function unavailableToolResult(toolName: string, phase: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `${toolName} is registered in Phase 1, but its full capability is intentionally unavailable until ${phase}.`
      }
    ]
  };
}

export function formatMemoryReadToolResult(result: MemoryReadResult): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: result.scope === 'all'
          ? 'Read persisted memory for memory and user scopes.'
          : `Read persisted memory for ${result.scope} scope.`
      }
    ],
    structuredContent: {
      scope: result.scope,
      content: result.content,
      memory: result.memory,
      user: result.user
    }
  };
}

export function formatMemoryWriteToolResult(result: MemoryWriteResult): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: result.mode === 'append'
          ? `Appended persisted memory for ${result.scope} scope.`
          : `Replaced persisted memory for ${result.scope} scope.`
      }
    ],
    structuredContent: {
      scope: result.scope,
      mode: result.mode,
      content: result.content
    }
  };
}

export function formatFileAnalyzeToolResult(result: FileAnalyzeResult): CallToolResult {
  const text = result.error
    ? result.error.message
    : result.answer ?? result.summary;

  return {
    isError: Boolean(result.error),
    content: [
      {
        type: 'text',
        text
      }
    ],
    structuredContent: {
      summary: result.summary,
      answer: result.answer,
      highlights: result.highlights,
      evidence: result.evidence,
      file: result.file,
      error: result.error
    }
  };
}

export function formatPrivacyControlToolResult(result: PrivacyControlResult): CallToolResult {
  const text = result.error
    ? result.error.message
    : result.action === 'status'
      ? 'Retrieved persisted privacy control status.'
      : `Updated privacy control via ${result.action}.`;

  return {
    isError: Boolean(result.error),
    content: [
      {
        type: 'text',
        text
      }
    ],
    structuredContent: {
      action: result.action,
      paused: result.paused,
      excludedApps: result.excludedApps,
      allowedDeleteRanges: result.allowedDeleteRanges,
      confirmationHint: result.confirmationHint,
      screenpipeStorage: result.screenpipeStorage,
      requestedRange: result.requestedRange,
      confirmed: result.confirmed,
      deletedFrames: result.deletedFrames,
      deletedElements: result.deletedElements,
      deletedExtractedContent: result.deletedExtractedContent,
      deletedSessions: result.deletedSessions,
      deletedEmbeddings: result.deletedEmbeddings,
      cascade: result.cascade,
      error: result.error
    }
  };
}
