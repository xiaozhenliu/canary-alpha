// src/config/config-secrets.ts
// Set of dot-paths for secret fields. get/list redact these paths by default (spec §7).
export const SECRET_PATHS: ReadonlySet<string> = new Set([
  'providers.embeddings.apiKey',
  'llm.api_key',
  'screenpipe.apiKey',
  'server.authToken'
]);

export function isSecretPath(path: string): boolean {
  return SECRET_PATHS.has(path);
}

// Redact: non-empty value → '***'; empty string / undefined / null → '(unset)'.
export function maskValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '(unset)';
  }
  return '***';
}
