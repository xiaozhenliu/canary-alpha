import type { FieldProps } from '../types';

export function NumberField({ path, schema, value, onChange }: FieldProps) {
  return (
    <input
      type="number"
      value={value !== undefined && value !== null ? Number(value) : ''}
      min={schema.minimum}
      step={schema.format === 'integer' ? 1 : 'any'}
      onChange={e => {
        const num = schema.format === 'integer'
          ? parseInt(e.target.value, 10)
          : parseFloat(e.target.value);
        if (!isNaN(num)) onChange(path, num);
      }}
      className="w-full bg-transparent border border-border rounded px-2 py-1 text-sm outline-none focus:border-foreground"
    />
  );
}
