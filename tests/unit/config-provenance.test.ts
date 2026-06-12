import { describe, it, expect, afterEach } from 'vitest';
import { computeConfigProvenance } from '../../src/config/config-provenance.js';

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; });

describe('computeConfigProvenance', () => {
  it('marks server.port overridden by MCP_PORT', () => {
    process.env.MCP_PORT = '9000';
    const p = computeConfigProvenance();
    expect(p.get('server.port')).toEqual({ overriddenByEnv: 'MCP_PORT' });
  });
  it('ignores SCREENPIPE_API_KEY when not managed', () => {
    delete process.env.CANARY_ALPHA_MCP_MANAGED_SERVICE;
    process.env.SCREENPIPE_API_KEY = 'x';
    expect(computeConfigProvenance().has('screenpipe.apiKey')).toBe(false);
  });
  it('honors SCREENPIPE_API_KEY when managed', () => {
    process.env.CANARY_ALPHA_MCP_MANAGED_SERVICE = '1';
    process.env.SCREENPIPE_API_KEY = 'x';
    expect(computeConfigProvenance().get('screenpipe.apiKey')).toEqual({ overriddenByEnv: 'SCREENPIPE_API_KEY' });
  });
  it('ignores empty CANARY_ALPHA_MCP_AUTH_TOKEN', () => {
    process.env.CANARY_ALPHA_MCP_AUTH_TOKEN = '';
    expect(computeConfigProvenance().has('server.authToken')).toBe(false);
  });
});
