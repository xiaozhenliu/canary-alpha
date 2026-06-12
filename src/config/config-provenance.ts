import { computeEnvOverrides } from './load-config.js';

export interface ProvenanceEntry {
  overriddenByEnv?: string;
}

// path → provenance。仅含被 env 覆盖的字段；其余字段调用方按 file/default 归类。
export function computeConfigProvenance(): Map<string, ProvenanceEntry> {
  const map = new Map<string, ProvenanceEntry>();
  for (const o of computeEnvOverrides()) {
    map.set(o.path, { overriddenByEnv: o.envName });
  }
  return map;
}
