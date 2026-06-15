import { StatusCard } from '../../../components/StatusCard';
import { MetricCard } from '../../../components/MetricCard';

export function ServerCard({ data }: { data: Record<string, unknown> }) {
  return (
    <StatusCard title="Server" status="ok">
      <MetricCard label="Mode" value={data.mode as string} />
      <MetricCard label="Address" value={`${data.host}:${data.port}`} />
      <MetricCard label="PID" value={data.pid as number} />
      <MetricCard label="Config" value={data.configFile as string} />
    </StatusCard>
  );
}
