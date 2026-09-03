#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const reportPath = process.argv[2];
const allowlistPath = process.argv[3];

if (!reportPath || !allowlistPath) {
  console.error('Usage: public-release-gitleaks-filter.js <report.json> <allowlist.txt>');
  process.exit(2);
}

function hashSecret(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

const report = JSON.parse(readFileSync(reportPath, 'utf8') || '[]');
const allow = new Set(
  readFileSync(allowlistPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
);

const unexpected = [];
for (const finding of report) {
  const fingerprint = String(finding.Fingerprint || '');
  const parts = fingerprint.split(':');
  const pathRuleLine = parts.length >= 4 ? parts.slice(1).join(':') : fingerprint;
  const secretHash = hashSecret(finding.Secret || '');
  const precise = `${pathRuleLine}:${secretHash}`;
  if (!allow.has(precise)) {
    unexpected.push(precise || fingerprint || JSON.stringify(finding));
  }
}

if (unexpected.length > 0) {
  process.stdout.write(`${unexpected.join('\n')}\n`);
  process.exit(1);
}
