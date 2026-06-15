interface MetricCardProps {
  label: string;
  value: string | number | undefined;
  sub?: string;
}

export function MetricCard({ label, value, sub }: MetricCardProps) {
  return (
    <div className="flex items-baseline justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="text-right">
        <span className="font-mono">{value ?? '—'}</span>
        {sub && <span className="text-muted-foreground/60 ml-1">{sub}</span>}
      </div>
    </div>
  );
}
