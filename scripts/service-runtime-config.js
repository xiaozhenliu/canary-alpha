const MANAGED_SERVICE_ENV_KEYS = ['MCP_PORT', 'MCP_LOG_LEVEL', 'SCREENPIPE_BASE_URL', 'SCREENPIPE_API_KEY'];
const MANAGED_SERVICE_SERVER_HOST_KEY = 'SCREENPIPE_MEMORY_MCP_SERVER_HOST';
const MANAGED_SERVICE_SERVER_PORT_KEY = 'SCREENPIPE_MEMORY_MCP_SERVER_PORT';

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlUnescape(value) {
  return value
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function parseOptionalPort(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsedPort = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
    throw new Error(`Invalid MCP_PORT value: ${value}`);
  }

  return parsedPort;
}

export function readServerConfig(parsed, configPath) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid config file at ${configPath}: root must be a YAML object.`);
  }

  const server = 'server' in parsed ? parsed.server : undefined;
  if (server !== undefined && (!server || typeof server !== 'object' || Array.isArray(server))) {
    throw new Error(`Invalid config file at ${configPath}: server must be an object.`);
  }

  let host = '127.0.0.1';
  if (server && 'host' in server) {
    if (typeof server.host !== 'string' || server.host.length === 0) {
      throw new Error(`Invalid config file at ${configPath}: server.host must be a non-empty string.`);
    }
    host = server.host;
  }

  let port = 8765;
  if (server && 'port' in server) {
    if (typeof server.port !== 'number' || !Number.isInteger(server.port) || server.port <= 0) {
      throw new Error(`Invalid config file at ${configPath}: server.port must be a positive integer.`);
    }
    port = server.port;
  }

  return { host, port };
}

export function applyServerEnvironmentOverrides(server, environment = process.env) {
  const overriddenPort = parseOptionalPort(environment.MCP_PORT);
  return {
    host: server.host,
    port: overriddenPort ?? server.port
  };
}

export function resolveManagedServiceServer(server, environment = process.env) {
  const managedHost = environment[MANAGED_SERVICE_SERVER_HOST_KEY];
  let managedPort;

  try {
    managedPort = parseOptionalPort(environment.MCP_PORT);
  } catch {
    managedPort = undefined;
  }

  managedPort ??= parseOptionalPort(environment[MANAGED_SERVICE_SERVER_PORT_KEY]);

  return {
    host: typeof managedHost === 'string' && managedHost.length > 0 ? managedHost : server.host,
    port: managedPort ?? server.port
  };
}

export function resolveManagedServiceEnvironment(environment = process.env) {
  const managedEnvironment = {};

  for (const key of MANAGED_SERVICE_ENV_KEYS) {
    const value = environment[key];
    if (typeof value === 'string' && value.length > 0) {
      managedEnvironment[key] = value;
    }
  }

  return managedEnvironment;
}

export function renderManagedServiceEnvironmentXml(homeDirectory, environment = process.env, server) {
  const entries = [
    ['HOME', homeDirectory],
    ['SCREENPIPE_MEMORY_MCP_MANAGED_SERVICE', '1'],
    [MANAGED_SERVICE_SERVER_HOST_KEY, server?.host ?? '127.0.0.1'],
    [MANAGED_SERVICE_SERVER_PORT_KEY, String(server?.port ?? 8765)],
    ...Object.entries(resolveManagedServiceEnvironment(environment))
  ];

  return entries
    .map(([key, value]) => `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`)
    .join('\n');
}

export function parseManagedServiceEnvironmentFromPlist(rawPlist) {
  const environmentBlock = rawPlist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!environmentBlock) {
    return {};
  }

  const parsedEnvironment = {};
  const keyValuePattern = /<key>([^<]+)<\/key>\s*<string>([\s\S]*?)<\/string>/g;

  for (const match of environmentBlock[1].matchAll(keyValuePattern)) {
    parsedEnvironment[xmlUnescape(match[1])] = xmlUnescape(match[2]);
  }

  return parsedEnvironment;
}
