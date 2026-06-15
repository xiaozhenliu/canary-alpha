import type { ReactNode } from 'react';

interface TimelineEntryProps {
  timestamp: string;
  title: string;
  status?: 'success' | 'failed' | 'skipped' | 'running';
  children?: ReactNode;
}

const STATUS_COLORS = {
  success: 'text-success',
  failed: 'text-destructive',
  skipped: 'text-muted-foreground',
  running: 'text-warning',
};

export function TimelineEntry({ timestamp, title, status, children }: TimelineEntryProps) {
  return (
    <div className="flex gap-3 py-2 border-b border-border last:border-0">
      <div className="text-xs text-muted-foreground font-mono w-36 shrink-0">
        {timestamp}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm">{title}</span>
          {status && (
            <span className={`text-xs ${STATUS_COLORS[status]}`}>{status}</span>
          )}
        </div>
        {children && <div className="mt-1 text-xs text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}
