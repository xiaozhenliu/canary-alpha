import { StatusCard } from '../../../components/StatusCard';
import { MetricCard } from '../../../components/MetricCard';

interface RetrievalData {
  checkpointExists?: boolean;
  checkpointTimestamp?: string;
  vectorStoreKind?: string;
  recoveryStatus?: string;
}

export function RetrievalCard({ data, degraded }: { data: Record<string, unknown>; degraded?: string }) {
  const retrieval = (data.retrieval ?? {}) as RetrievalData;
  const status = retrieval.recoveryStatus === 'ready' ? 'ok'
    : retrieval.recoveryStatus === 'degraded' ? 'degraded' : 'unavailable';

  return (
    <StatusCard title="Retrieval" status={degraded ? 'degraded' : status as 'ok' | 'degraded' | 'unavailable'} degraded={degraded}>
      <MetricCard label="Vector Store" value={retrieval.vectorStoreKind} />
      <MetricCard label="Recovery" value={retrieval.recoveryStatus} />
      <MetricCard label="Checkpoint" value={retrieval.checkpointTimestamp ?? (retrieval.checkpointExists ? 'exists' : 'none')} />
    </StatusCard>
  );
}
