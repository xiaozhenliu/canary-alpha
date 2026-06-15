import type { ReactNode } from 'react';

interface StatusCardProps {
  title: string;
  status?: 'ok' | 'degraded' | 'unavailable';
  degraded?: string;
  children: ReactNode;
}

const STATUS_COLORS = {
  ok: 'bg-success',
  degraded: 'bg-warning',
  unavailable: 'bg-destructive',
};

export function StatusCard({ title, status = 'ok', degraded, children }: StatusCardProps) {
  return (
    <div className="border border-border rounded-lg bg-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[status]}`} />
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      {degraded && (
        <div className="text-xs text-warning bg-warning/10 rounded px-2 py-1 mb-3">
          {degraded}
        </div>
      )}
      <div className="space-y-2">{children}</div>
    </div>
  );
}
