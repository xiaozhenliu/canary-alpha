import { useState, useCallback } from 'react';
import { api } from '../../lib/api-client';
import { usePolling } from '../../lib/use-polling';

interface LogEntry {
  timestamp?: string;
  level?: string;
  message?: string;
  raw?: string;
  [key: string]: unknown;
}

const LEVEL_COLORS: Record<string, string> = {
  debug: 'text-muted-foreground',
  info: 'text-foreground',
  warn: 'text-warning',
  error: 'text-destructive',
};

export function LogsPage() {
  const [levelFilter, setLevelFilter] = useState<string>('');

  const fetcher = useCallback(
    () => api<{ entries: LogEntry[] }>(`/logs?limit=200${levelFilter ? `&level=${levelFilter}` : ''}`),
    [levelFilter]
  );
  const { data, loading, refresh } = usePolling(fetcher, 15_000);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Logs</h2>
        <div className="flex gap-2">
          <select
            value={levelFilter}
            onChange={e => setLevelFilter(e.target.value)}
            className="bg-background border border-border rounded px-2 py-1 text-xs"
          >
            <option value="">All levels</option>
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
          <button onClick={refresh} className="text-xs text-muted-foreground hover:text-foreground">
            Refresh
          </button>
        </div>
      </div>

      {loading && <div className="text-xs text-muted-foreground">Loading...</div>}

      <div className="border border-border rounded-lg bg-card overflow-auto max-h-[70vh]">
        <div className="p-2 space-y-0.5 font-mono text-[11px]">
          {data?.entries.map((entry, i) => (
            <div key={i} className="flex gap-2 py-0.5 hover:bg-accent/20">
              {entry.raw ? (
                <span className="text-muted-foreground">{entry.raw}</span>
              ) : (
                <>
                  <span className="text-muted-foreground/60 w-20 shrink-0">{formatLogTime(entry.timestamp)}</span>
                  <span className={`w-10 shrink-0 ${LEVEL_COLORS[entry.level ?? ''] ?? 'text-foreground'}`}>
                    {entry.level}
                  </span>
                  <span>{entry.message}</span>
                </>
              )}
            </div>
          ))}
          {data?.entries.length === 0 && <div className="text-muted-foreground p-2">No log entries.</div>}
        </div>
      </div>
    </div>
  );
}

function formatLogTime(ts?: string): string {
  if (!ts) return '';
  try {
    return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ts));
  } catch {
    return ts;
  }
}
