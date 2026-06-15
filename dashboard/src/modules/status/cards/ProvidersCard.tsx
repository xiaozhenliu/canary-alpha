import { StatusCard } from '../../../components/StatusCard';
import { MetricCard } from '../../../components/MetricCard';

interface ProvidersStatus {
  embedding?: {
    kind?: string;
    model?: string;
    status?: string;
  };
}

export function ProvidersCard({ data, degraded }: { data: Record<string, unknown>; degraded?: string }) {
  const providers = (data.providers ?? {}) as ProvidersStatus;
  const emb = providers.embedding ?? {};

  return (
    <StatusCard title="Providers" status={degraded ? 'degraded' : 'ok'} degraded={degraded}>
      <MetricCard label="Embedding Kind" value={emb.kind} />
      <MetricCard label="Model" value={emb.model} />
      <MetricCard label="Status" value={emb.status} />
    </StatusCard>
  );
}
