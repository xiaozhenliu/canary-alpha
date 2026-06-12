import { computeEnvOverrides } from './load-config.js';

export interface ProvenanceEntry {
  overriddenByEnv?: string;
}

// path → provenance. Contains only fields overridden by env; remaining fields are classified as file/default by the caller.
export function computeConfigProvenance(): Map<string, ProvenanceEntry> {
  const map = new Map<string, ProvenanceEntry>();
  for (const o of computeEnvOverrides()) {
    map.set(o.path, { overriddenByEnv: o.envName });
  }
  return map;
}
