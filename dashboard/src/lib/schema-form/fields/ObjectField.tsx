import type { FieldProps } from '../types';
import { SchemaForm } from '../SchemaForm';

export function ObjectField({ path, schema, value, onChange }: FieldProps) {
  if (!schema.properties) return null;

  return (
    <div className="border-l border-border pl-3 ml-1">
      <SchemaForm
        schema={schema}
        values={(value as Record<string, unknown>) ?? {}}
        onChange={onChange}
        pathPrefix={path}
      />
    </div>
  );
}
