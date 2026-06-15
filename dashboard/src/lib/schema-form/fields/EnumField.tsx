import type { FieldProps } from '../types';

export function EnumField({ path, schema, value, onChange }: FieldProps) {
  return (
    <select
      value={String(value ?? '')}
      onChange={e => onChange(path, e.target.value)}
      className="w-full bg-background border border-border rounded px-2 py-1 text-sm outline-none focus:border-foreground"
    >
      {schema.enum?.map(opt => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
    </select>
  );
}
