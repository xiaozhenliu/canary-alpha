import { describe, expect, it } from 'vitest';

import { appConfigSchema } from '../../src/config/schema.js';
import { createCaptureProvider } from '../../src/services/capture/provider-factory.js';

describe('createCaptureProvider', () => {
  it('builds the screenpipe provider by default', () => {
    const config = appConfigSchema.parse({});
    const provider = createCaptureProvider(config as never);

    expect(provider.capabilities.providerName).toBe('screenpipe');
    expect(provider.capabilities.retentionTrim).toBe(true);
    expect(provider.client).toBeDefined();
    expect(provider.frameDetail).toBeDefined();
    expect(provider.lifecycle).toBeDefined();
    expect(provider.upstreamDatabasePath).toMatch(/\.screenpipe/);
  });

  it('defaults capture.provider to screenpipe in the schema', () => {
    const config = appConfigSchema.parse({});
    expect(config.capture.provider).toBe('screenpipe');
  });
});
