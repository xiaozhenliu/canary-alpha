import { Client, StdioClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const PROJECT_ROOT = '/Users/xz/Projects/lifecapture-mcp';

export interface ConnectedClient {
  client: Client;
  close(): Promise<void>;
}

function createClient(): Client {
  return new Client({
    name: 'screenpipe-memory-mcp-test-client',
    version: '0.1.0'
  });
}

function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

export async function connectStdioClient(env: NodeJS.ProcessEnv = {}): Promise<ConnectedClient> {
  const client = createClient();
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts', '--mode', 'stdio'],
    cwd: PROJECT_ROOT,
    env: normalizeEnv({
      ...process.env,
      ...env
    }),
    stderr: 'pipe'
  });

  await client.connect(transport);

  return {
    client,
    async close(): Promise<void> {
      await client.close();
    }
  };
}

export async function connectHttpClient(port: number): Promise<ConnectedClient> {
  const client = createClient();
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

  await client.connect(transport);

  return {
    client,
    async close(): Promise<void> {
      await transport.terminateSession();
      await client.close();
    }
  };
}
