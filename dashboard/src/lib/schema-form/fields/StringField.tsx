import type { FieldProps } from '../types';
import { SecretField } from '../../../components/SecretField';
import { api } from '../../api-client';

export function StringField({ path, schema, value, onChange }: FieldProps) {
  if (schema.isSecret) {
    return (
      <SecretField
        value={String(value ?? '')}
        onReveal={async () => {
          const res = await api<{ path: string; display: string; source: string }>(
            `/config/get?path=${encodeURIComponent(path)}&reveal=true`
          );
          return res.display;
        }}
      />
    );
  }
  return (
    <input
      type="text"
      value={String(value ?? '')}
      onChange={e => onChange(path, e.target.value)}
      className="w-full bg-transparent border border-border rounded px-2 py-1 text-sm outline-none focus:border-foreground"
    />
  );
}
