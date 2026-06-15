import { StatusCard } from '../../../components/StatusCard';
import { MetricCard } from '../../../components/MetricCard';

interface ExtractionStatus {
  totalExtractions?: number;
  recentExtractions?: number;
}

interface SessionsStatus {
  totalSessions?: number;
}

export function WorkActivityCard({ data, degraded }: { data: Record<string, unknown>; degraded?: string }) {
  const extraction = (data.extraction ?? {}) as ExtractionStatus;
  const sessions = (data.sessions ?? {}) as SessionsStatus;

  return (
    <StatusCard title="Work Activity" status={degraded ? 'degraded' : 'ok'} degraded={degraded}>
      <MetricCard label="Extractions" value={extraction.totalExtractions} />
      <MetricCard label="Recent" value={extraction.recentExtractions} />
      <MetricCard label="Sessions" value={sessions.totalSessions} />
    </StatusCard>
  );
}
