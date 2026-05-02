#!/usr/bin/env node

import { collectStorageDiagnostics, formatStorageDiagnosticsReport, summarizeDominantArtifacts } from '../src/services/diagnostics/storage-diagnostics.js';
import { loadConfig } from '../src/config/load-config.js';

async function loadVectorStoreConfig() {
  try {
    const config = await loadConfig();
    return {
      vectorStore: config.vectorStore,
      warning: undefined
    };
  } catch (error) {
    return {
      vectorStore: undefined,
      warning: error instanceof Error ? error.message : String(error)
    };
  }
}

const { vectorStore, warning } = await loadVectorStoreConfig();
const report = await collectStorageDiagnostics({ vectorStore });

process.stdout.write(formatStorageDiagnosticsReport(report));
process.stdout.write('\nTop artifacts:\n');
for (const line of summarizeDominantArtifacts(report, 3)) {
  process.stdout.write(`- ${line}\n`);
}
if (warning) {
  process.stdout.write(`\nConfig warning: ${warning}\n`);
}
