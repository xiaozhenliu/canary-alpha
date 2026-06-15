import { useState, useCallback, useEffect } from 'react';
import { api } from '../../lib/api-client';
import { SchemaForm } from '../../lib/schema-form/SchemaForm';
import type { JsonSchemaNode } from '../../lib/schema-form/types';

export function ConfigPage() {
  const [schema, setSchema] = useState<JsonSchemaNode | null>(null);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [provenance, setProvenance] = useState<Map<string, { overriddenByEnv?: string }>>(new Map());
  const [message, setMessage] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);

  const loadConfig = useCallback(async () => {
    const [schemaRes, effectiveRes, listRes] = await Promise.all([
      api<JsonSchemaNode>('/config/schema'),
      api<{ config: Record<string, unknown> }>('/config/effective'),
      api<{ entries: Array<{ path: string; overriddenByEnv?: string }> }>('/config'),
    ]);
    setSchema(schemaRes);
    setConfig(effectiveRes.config);
    const prov = new Map<string, { overriddenByEnv?: string }>();
    for (const e of listRes.entries) {
      if (e.overriddenByEnv) prov.set(e.path, { overriddenByEnv: e.overriddenByEnv });
    }
    setProvenance(prov);
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const handleFieldSave = async (path: string, value: unknown, fieldSchema: JsonSchemaNode) => {
    try {
      if (fieldSchema.type === 'array' && Array.isArray(value)) {
        setMessage({ text: 'Array fields use inline add/remove buttons.', type: 'ok' });
        return;
      }
      await api('/config/set', {
        method: 'POST',
        body: JSON.stringify({ path, value: String(value) })
      });
      setMessage({ text: `Saved ${path}. Restart service to apply.`, type: 'ok' });
      await loadConfig();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : 'Save failed', type: 'error' });
    }
  };

  if (!schema) return <div className="text-muted-foreground text-sm">Loading config schema...</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Configuration</h2>
        {message && (
          <span className={`text-xs ${message.type === 'ok' ? 'text-success' : 'text-destructive'}`}>
            {message.text}
          </span>
        )}
      </div>

      <div className="border border-border rounded-lg p-3 mb-6 bg-card">
        <div className="text-xs text-muted-foreground mb-1">After saving, restart the service for changes to take effect:</div>
        <code className="text-xs font-mono bg-muted px-2 py-1 rounded select-all">
          npm run service:stop &amp;&amp; npm run service:start
        </code>
      </div>

      <div className="space-y-4">
        {schema.properties && Object.entries(schema.properties).map(([section, sectionSchema]) => (
          <ConfigSection
            key={section}
            title={section}
            schema={sectionSchema}
            values={(config[section] ?? {}) as Record<string, unknown>}
            provenance={provenance}
            sectionPath={section}
            onSave={handleFieldSave}
          />
        ))}
      </div>
    </div>
  );
}

function ConfigSection({ title, schema, values, provenance, sectionPath, onSave }: {
  title: string;
  schema: JsonSchemaNode;
  values: Record<string, unknown>;
  provenance: Map<string, { overriddenByEnv?: string }>;
  sectionPath: string;
  onSave: (path: string, value: unknown, schema: JsonSchemaNode) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasEnvOverride = [...provenance.keys()].some(k => k.startsWith(sectionPath + '.'));
  return (
    <div className="border border-border rounded-lg">
      <button type="button" onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-accent/30">
        <span className="font-mono">{title}</span>
        <div className="flex items-center gap-2">
          {hasEnvOverride && <span className="text-[10px] text-warning">env override</span>}
          <span className="text-muted-foreground">{open ? '▾' : '▸'}</span>
        </div>
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-border pt-3">
          <SchemaForm
            schema={schema}
            values={values}
            onChange={(path, value) => {
              const fieldSchema = findFieldSchema(schema, path, sectionPath);
              onSave(path, value, fieldSchema ?? { type: 'string' });
            }}
            pathPrefix={sectionPath}
          />
        </div>
      )}
    </div>
  );
}

function findFieldSchema(schema: JsonSchemaNode, fullPath: string, prefix: string): JsonSchemaNode | undefined {
  const relativePath = fullPath.startsWith(prefix + '.') ? fullPath.slice(prefix.length + 1) : fullPath;
  const parts = relativePath.split('.');
  let current = schema;
  for (const part of parts) {
    if (current.properties?.[part]) {
      current = current.properties[part];
    } else {
      return undefined;
    }
  }
  return current;
}
