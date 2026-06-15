import { StatusCard } from '../../../components/StatusCard';
import { MetricCard } from '../../../components/MetricCard';

interface IngestionMix {
  totalFrames?: number;
  axPercentage?: number;
  ocrPercentage?: number;
}

export function IngestionCard({ data, degraded }: { data: Record<string, unknown>; degraded?: string }) {
  const mix = (data.ingestionMix ?? {}) as IngestionMix;

  return (
    <StatusCard title="Ingestion Mix" status={degraded ? 'degraded' : 'ok'} degraded={degraded}>
      <MetricCard label="Total Frames (24h)" value={mix.totalFrames} />
      <MetricCard label="AX" value={mix.axPercentage !== undefined ? `${mix.axPercentage.toFixed(1)}%` : undefined} />
      <MetricCard label="OCR" value={mix.ocrPercentage !== undefined ? `${mix.ocrPercentage.toFixed(1)}%` : undefined} />
    </StatusCard>
  );
}
