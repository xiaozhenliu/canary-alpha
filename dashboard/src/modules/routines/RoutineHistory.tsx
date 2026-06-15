import { useCallback } from 'react';
import { api } from '../../lib/api-client';
import { usePolling } from '../../lib/use-polling';
import { TimelineEntry } from '../../components/TimelineEntry';

interface RunEntry {
  runId: string;
  timestamp: string;
  status: 'success' | 'failed' | 'skipped';
  summary?: string;
}

export function RoutineHistory({ name }: { name: string }) {
  const fetcher = useCallback(() => api<{ runs: RunEntry[] }>(`/routines/${encodeURIComponent(name)}/history?limit=20`), [name]);
  const { data, loading } = usePolling(fetcher, 60_000);

  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">History: <span className="font-mono">{name}</span></h2>
      {loading && <div className="text-xs text-muted-foreground">Loading...</div>}
      <div>
        {data?.runs.map(run => (
          <TimelineEntry
            key={run.runId}
            timestamp={formatTimestamp(run.timestamp)}
            title={run.runId}
            status={run.status}
          >
            {run.summary}
          </TimelineEntry>
        ))}
        {data?.runs.length === 0 && <div className="text-xs text-muted-foreground">No execution history.</div>}
      </div>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
