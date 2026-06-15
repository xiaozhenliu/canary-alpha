import { StatusCard } from '../../../components/StatusCard';
import { MetricCard } from '../../../components/MetricCard';

interface CaptureData {
  provider?: string;
  livenessState?: string;
  latestFrameTimestamp?: string;
}

export function CaptureCard({ data, degraded }: { data: Record<string, unknown>; degraded?: string }) {
  const capture = (data.capture ?? {}) as CaptureData;
  const status = capture.livenessState === 'ok' ? 'ok'
    : capture.livenessState === 'unavailable' ? 'unavailable' : 'degraded';

  return (
    <StatusCard title="Capture" status={degraded ? 'degraded' : status as 'ok' | 'degraded' | 'unavailable'} degraded={degraded}>
      <MetricCard label="Provider" value={capture.provider} />
      <MetricCard label="Liveness" value={capture.livenessState} />
      <MetricCard label="Latest Frame" value={capture.latestFrameTimestamp ? formatTime(capture.latestFrameTimestamp) : undefined} />
    </StatusCard>
  );
}

function formatTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso));
  } catch {
    return iso;
  }
}
