import { describe, expect, it } from 'vitest';

import {
  applyServerEnvironmentOverrides,
  parseManagedServiceEnvironmentFromPlist,
  readServerConfig,
  renderManagedServiceEnvironmentXml,
  resolveManagedServiceEnvironment,
  resolveManagedServiceServer
} from '../../scripts/service-runtime-config.js';

describe('managed service runtime config', () => {
  it('preserves supported env-backed overrides in launchd plist XML', () => {
    const environmentXml = renderManagedServiceEnvironmentXml('/Users/tester', {
      MCP_PORT: '18765',
      MCP_LOG_LEVEL: 'debug',
      SCREENPIPE_BASE_URL: 'http://127.0.0.1:3031',
      SCREENPIPE_API_KEY: 'screenpipe-secret',
      IGNORED_FLAG: 'nope'
    });

    const parsedEnvironment = parseManagedServiceEnvironmentFromPlist(`
      <plist>
        <dict>
          <key>EnvironmentVariables</key>
          <dict>
${environmentXml}
          </dict>
        </dict>
      </plist>
    `);

    expect(parsedEnvironment).toEqual({
      HOME: '/Users/tester',
      SCREENPIPE_MEMORY_MCP_MANAGED_SERVICE: '1',
      SCREENPIPE_MEMORY_MCP_SERVER_HOST: '127.0.0.1',
      SCREENPIPE_MEMORY_MCP_SERVER_PORT: '8765',
      MCP_PORT: '18765',
      MCP_LOG_LEVEL: 'debug',
      SCREENPIPE_BASE_URL: 'http://127.0.0.1:3031',
      SCREENPIPE_API_KEY: 'screenpipe-secret'
    });
  });

  it('keeps Screenpipe capture and recorder flags out of the managed-service environment', () => {
    const mixedEnvironment = {
      MCP_PORT: '18765',
      MCP_LOG_LEVEL: 'debug',
      SCREENPIPE_BASE_URL: 'http://127.0.0.1:3031',
      SCREENPIPE_API_KEY: 'screenpipe-secret',
      SCREENPIPE_ENABLE_RECORDING: '1',
      SCREENPIPE_ENABLE_SCREEN_CAPTURE: '1',
      SCREENPIPE_RECORDER_MODE: 'continuous',
      SCREENPIPE_RECORDING_OUTPUT_DIR: '/tmp/screenpipe-recordings',
      SCREENPIPE_UPLOAD_URL: 'https://example.com/upload',
      OLLAMA_HOST: 'http://127.0.0.1:11434'
    };

    expect(resolveManagedServiceEnvironment(mixedEnvironment)).toEqual({
      MCP_PORT: '18765',
      MCP_LOG_LEVEL: 'debug',
      SCREENPIPE_BASE_URL: 'http://127.0.0.1:3031',
      SCREENPIPE_API_KEY: 'screenpipe-secret'
    });

    const environmentXml = renderManagedServiceEnvironmentXml('/Users/tester', mixedEnvironment, {
      host: '127.0.0.1',
      port: 18765
    });

    const parsedEnvironment = parseManagedServiceEnvironmentFromPlist(`
      <plist>
        <dict>
          <key>EnvironmentVariables</key>
          <dict>
${environmentXml}
          </dict>
        </dict>
      </plist>
    `);

    expect(parsedEnvironment).toEqual({
      HOME: '/Users/tester',
      SCREENPIPE_MEMORY_MCP_MANAGED_SERVICE: '1',
      SCREENPIPE_MEMORY_MCP_SERVER_HOST: '127.0.0.1',
      SCREENPIPE_MEMORY_MCP_SERVER_PORT: '18765',
      MCP_PORT: '18765',
      MCP_LOG_LEVEL: 'debug',
      SCREENPIPE_BASE_URL: 'http://127.0.0.1:3031',
      SCREENPIPE_API_KEY: 'screenpipe-secret'
    });
    expect(parsedEnvironment.SCREENPIPE_ENABLE_RECORDING).toBeUndefined();
    expect(parsedEnvironment.SCREENPIPE_ENABLE_SCREEN_CAPTURE).toBeUndefined();
    expect(parsedEnvironment.SCREENPIPE_RECORDER_MODE).toBeUndefined();
    expect(parsedEnvironment.SCREENPIPE_RECORDING_OUTPUT_DIR).toBeUndefined();
    expect(parsedEnvironment.SCREENPIPE_UPLOAD_URL).toBeUndefined();
    expect(parsedEnvironment.OLLAMA_HOST).toBeUndefined();
  });

  it('ignores hostile debug and managed-service env when rendering launchd XML', () => {
    const hostileEnvironment = {
      MCP_PORT: '18765',
      MCP_LOG_LEVEL: 'debug',
      SCREENPIPE_BASE_URL: 'http://127.0.0.1:3031',
      SCREENPIPE_API_KEY: 'screenpipe-secret',
      SCREENPIPE_MEMORY_MCP_SERVER_HOST: '0.0.0.0',
      SCREENPIPE_MEMORY_MCP_SERVER_PORT: '29999',
      DEBUG: 'screenpipe:*',
      NODE_OPTIONS: '--inspect',
      PATH: '/tmp/fake-bin',
      HOME: '/tmp/attacker-home',
      SCREENPIPE_ENABLE_AUDIO: '1',
      SCREENPIPE_ENABLE_VISION: '1',
      SCREENPIPE_CAPTURE_RAW_TEXT: '1',
      SCREENPIPE_RECORDING_OUTPUT_DIR: '/tmp/screenpipe-recordings'
    };

    const environmentXml = renderManagedServiceEnvironmentXml('/Users/tester', hostileEnvironment, {
      host: '127.0.0.1',
      port: 18765
    });

    const parsedEnvironment = parseManagedServiceEnvironmentFromPlist(`
      <plist>
        <dict>
          <key>EnvironmentVariables</key>
          <dict>
${environmentXml}
          </dict>
        </dict>
      </plist>
    `);

    expect(parsedEnvironment).toEqual({
      HOME: '/Users/tester',
      SCREENPIPE_MEMORY_MCP_MANAGED_SERVICE: '1',
      SCREENPIPE_MEMORY_MCP_SERVER_HOST: '127.0.0.1',
      SCREENPIPE_MEMORY_MCP_SERVER_PORT: '18765',
      MCP_PORT: '18765',
      MCP_LOG_LEVEL: 'debug',
      SCREENPIPE_BASE_URL: 'http://127.0.0.1:3031',
      SCREENPIPE_API_KEY: 'screenpipe-secret'
    });
    expect(parsedEnvironment.DEBUG).toBeUndefined();
    expect(parsedEnvironment.NODE_OPTIONS).toBeUndefined();
    expect(parsedEnvironment.PATH).toBeUndefined();
    expect(parsedEnvironment.SCREENPIPE_ENABLE_AUDIO).toBeUndefined();
    expect(parsedEnvironment.SCREENPIPE_ENABLE_VISION).toBeUndefined();
    expect(parsedEnvironment.SCREENPIPE_CAPTURE_RAW_TEXT).toBeUndefined();
    expect(parsedEnvironment.SCREENPIPE_RECORDING_OUTPUT_DIR).toBeUndefined();
  });

  it('resolves the managed-service endpoint from frozen launchd values', () => {
    const runningServer = resolveManagedServiceServer({
      host: '127.0.0.1',
      port: 9999
    }, {
      SCREENPIPE_MEMORY_MCP_SERVER_HOST: '127.0.0.1',
      SCREENPIPE_MEMORY_MCP_SERVER_PORT: '18765'
    });

    expect(runningServer).toEqual({
      host: '127.0.0.1',
      port: 18765
    });
  });

  it('prefers MCP_PORT over the frozen managed-service port when resolving the probed endpoint', () => {
    const runningServer = resolveManagedServiceServer({
      host: '127.0.0.1',
      port: 9999
    }, {
      SCREENPIPE_MEMORY_MCP_SERVER_HOST: '127.0.0.1',
      SCREENPIPE_MEMORY_MCP_SERVER_PORT: '18765',
      MCP_PORT: '19999'
    });

    expect(runningServer).toEqual({
      host: '127.0.0.1',
      port: 19999
    });
  });

  it('falls back to the frozen managed-service port when MCP_PORT is invalid', () => {
    const runningServer = resolveManagedServiceServer({
      host: '127.0.0.1',
      port: 9999
    }, {
      SCREENPIPE_MEMORY_MCP_SERVER_HOST: '127.0.0.1',
      SCREENPIPE_MEMORY_MCP_SERVER_PORT: '18765',
      MCP_PORT: 'broken'
    });

    expect(runningServer).toEqual({
      host: '127.0.0.1',
      port: 18765
    });
  });

  it('applies MCP_PORT overrides after reading server config defaults', () => {
    const parsedConfig = readServerConfig({
      server: {
        host: '127.0.0.1',
        port: 8765
      }
    }, '/tmp/config.yaml');

    const runtimeConfig = applyServerEnvironmentOverrides(parsedConfig, {
      MCP_PORT: '18765'
    });

    expect(runtimeConfig).toEqual({
      host: '127.0.0.1',
      port: 18765
    });
  });
});
