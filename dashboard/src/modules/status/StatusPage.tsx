import { useCallback } from 'react';
import { api } from '../../lib/api-client';
import { usePolling } from '../../lib/use-polling';
import { ServerCard } from './cards/ServerCard';
import { CaptureCard } from './cards/CaptureCard';
import { RetrievalCard } from './cards/RetrievalCard';
import { IngestionCard } from './cards/IngestionCard';
import { DiskCard } from './cards/DiskCard';
import { WorkActivityCard } from './cards/WorkActivityCard';
import { ProvidersCard } from './cards/ProvidersCard';

export function StatusPage() {
  const fetcher = useCallback(() => api<Record<string, unknown>>('/status'), []);
  const { data, error, loading, refresh } = usePolling(fetcher);

  if (loading) return <div className="text-sm text-muted-foreground">Loading status...</div>;
  if (error) return <div className="text-sm text-destructive">Error: {error}</div>;
  if (!data) return null;

  const degraded = (data.degraded ?? {}) as Record<string, string>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Status Dashboard</h2>
        <button onClick={refresh} className="text-xs text-muted-foreground hover:text-foreground">
          Refresh
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <ServerCard data={data} />
        <CaptureCard data={data} degraded={degraded.capture} />
        <RetrievalCard data={data} degraded={degraded.retrieval} />
        <IngestionCard data={data} degraded={degraded.ingestionMix} />
        <DiskCard data={data} degraded={degraded.diskBudget} />
        <WorkActivityCard data={data} degraded={degraded.extraction} />
        <ProvidersCard data={data} degraded={degraded.providers} />
      </div>
    </div>
  );
}
