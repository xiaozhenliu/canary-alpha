export function readServerConfig(parsed: unknown, configPath: string): {
  host: string;
  port: number;
};

export function applyServerEnvironmentOverrides(
  server: { host: string; port: number },
  environment?: Record<string, string | undefined>
): {
  host: string;
  port: number;
};

export function resolveManagedServiceServer(
  server: { host: string; port: number },
  environment?: Record<string, string | undefined>
): {
  host: string;
  port: number;
};

export function resolveManagedServiceEnvironment(
  environment?: Record<string, string | undefined>
): Record<string, string>;

export function renderManagedServiceEnvironmentXml(
  homeDirectory: string,
  environment?: Record<string, string | undefined>,
  server?: { host: string; port: number }
): string;

export function parseManagedServiceEnvironmentFromPlist(rawPlist: string): Record<string, string>;
