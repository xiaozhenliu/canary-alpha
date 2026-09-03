import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appConfigSchema } from '../../../src/config/schema.js';
import { createCaptureProvider } from '../../../src/services/capture/provider-factory.js';
import type { AppConfig } from '../../../src/types/app-config.js';

describe('Screenpipe provider configuration', () => {
  it('uses the configured data directory for direct SQLite access', () => {
    const config = appConfigSchema.parse({
      screenpipe: {
        url: 'http://127.0.0.1:3031',
        dataDirectory: '/tmp/screenpipe-dev-0.4.15'
      }
    }) as AppConfig;

    const provider = createCaptureProvider(config);

    expect(provider.upstreamDatabasePath).toBe(join('/tmp/screenpipe-dev-0.4.15', 'db.sqlite'));
  });
});
