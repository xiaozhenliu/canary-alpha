import { StatusCard } from '../../../components/StatusCard';
import { MetricCard } from '../../../components/MetricCard';

interface DiskBudget {
  totalBytes?: number;
  budgetBytes?: number | null;
  usagePercent?: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function DiskCard({ data, degraded }: { data: Record<string, unknown>; degraded?: string }) {
  const disk = (data.diskBudget ?? {}) as DiskBudget;

  return (
    <StatusCard title="Disk Budget" status={degraded ? 'degraded' : 'ok'} degraded={degraded}>
      <MetricCard label="Total" value={disk.totalBytes !== undefined ? formatBytes(disk.totalBytes) : undefined} />
      <MetricCard label="Budget" value={disk.budgetBytes ? formatBytes(disk.budgetBytes) : 'unlimited'} />
      <MetricCard label="Usage" value={disk.usagePercent !== undefined ? `${disk.usagePercent.toFixed(1)}%` : undefined} />
    </StatusCard>
  );
}
