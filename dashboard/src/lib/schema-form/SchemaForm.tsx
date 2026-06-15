import type { JsonSchemaNode } from './types';
import { StringField } from './fields/StringField';
import { NumberField } from './fields/NumberField';
import { BooleanField } from './fields/BooleanField';
import { EnumField } from './fields/EnumField';
import { ArrayField } from './fields/ArrayField';
import { ObjectField } from './fields/ObjectField';

interface SchemaFormProps {
  schema: JsonSchemaNode;
  values: Record<string, unknown>;
  onChange: (path: string, value: unknown) => void;
  pathPrefix?: string;
}

export function SchemaForm({ schema, values, onChange, pathPrefix = '' }: SchemaFormProps) {
  if (!schema.properties) return null;

  return (
    <div className="space-y-3">
      {Object.entries(schema.properties).map(([key, fieldSchema]) => {
        const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;
        const value = values[key];

        return (
          <div key={key}>
            <label className="block text-xs text-muted-foreground mb-1 font-mono">{key}</label>
            <FieldRenderer path={fullPath} schema={fieldSchema} value={value} onChange={onChange} />
          </div>
        );
      })}
    </div>
  );
}

function FieldRenderer({ path, schema, value, onChange }: {
  path: string; schema: JsonSchemaNode; value: unknown; onChange: (path: string, value: unknown) => void;
}) {
  if (schema.enum) {
    return <EnumField path={path} schema={schema} value={value} onChange={onChange} />;
  }

  switch (schema.type) {
    case 'string':
      return <StringField path={path} schema={schema} value={value} onChange={onChange} />;
    case 'number':
      return <NumberField path={path} schema={schema} value={value} onChange={onChange} />;
    case 'boolean':
      return <BooleanField path={path} schema={schema} value={value} onChange={onChange} />;
    case 'array':
      return <ArrayField path={path} schema={schema} value={value} onChange={onChange} />;
    case 'object':
      return <ObjectField path={path} schema={schema} value={value} onChange={onChange} />;
    default:
      return <StringField path={path} schema={schema} value={value} onChange={onChange} />;
  }
}
