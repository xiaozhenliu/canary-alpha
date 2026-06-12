// src/config/config-secrets.ts
// 密钥字段的点路径集合。get/list 默认对这些路径脱敏（spec §7）。
export const SECRET_PATHS: ReadonlySet<string> = new Set([
  'providers.embeddings.apiKey',
  'llm.api_key',
  'screenpipe.apiKey',
  'server.authToken'
]);

export function isSecretPath(path: string): boolean {
  return SECRET_PATHS.has(path);
}

// 脱敏：非空 → '***'；空串/undefined/null → '(unset)'。
export function maskValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '(unset)';
  }
  return '***';
}
