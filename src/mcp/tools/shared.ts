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
import type {
  FreshnessStatus,
  RecentActivityResult,
  RetrievalActionableError,
  SearchScreenResult
} from '../../services/retrieval/types.js';

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

function formatFreshness(freshness: FreshnessStatus | undefined): string {
  if (!freshness) {
    return 'unknown freshness';
  }

  const lag = freshness.lagMinutes === null ? 'unknown' : `${freshness.lagMinutes}`;
  return `${freshness.status} (lag ${lag} minute(s), window ${freshness.windowMinutes})`;
}

function formatActionableError(error: RetrievalActionableError | undefined): string | undefined {
  if (!error) {
    return undefined;
  }

  return `${error.message} ${error.action}`;
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
      error: result.error
    }
  };
}

export function formatSearchScreenToolResult(result: SearchScreenResult): CallToolResult {
  return {
    isError: Boolean(result.error),
    content: [
      {
        type: 'text',
        text: result.error
          ? `${result.summary} ${formatActionableError(result.error)}`
          : `${result.summary} Freshness: ${formatFreshness(result.freshness)}.`
      }
    ],
    structuredContent: {
      summary: result.summary,
      evidence: result.evidence,
      degraded: result.degraded,
      freshness: result.freshness,
      error: result.error
    }
  };
}

export function formatRecentActivityToolResult(result: RecentActivityResult): CallToolResult {
  return {
    isError: Boolean(result.error),
    content: [
      {
        type: 'text',
        text: result.error
          ? `${result.summary} ${formatActionableError(result.error)}`
          : `${result.summary} Freshness: ${formatFreshness(result.freshness)}.`
      }
    ],
    structuredContent: {
      summary: result.summary,
      evidence: result.evidence,
      raw: result.raw,
      freshness: result.freshness,
      error: result.error
    }
  };
}
