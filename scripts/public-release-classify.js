#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST_PATH = join(scriptDirectory, 'public-release-manifest.txt');

/**
 * Convert a manifest glob into a RegExp anchored to the full repository path.
 */
export function globToRegExp(pattern) {
  let regex = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === '*' && next === '*') {
      if (pattern[index + 2] === '/') {
        regex += '(?:.*/)?';
        index += 2;
      } else {
        regex += '.*';
        index += 1;
      }
      continue;
    }

    if (char === '*') {
      regex += '[^/]*';
      continue;
    }

    if ('\\.[]{}()+^$|?'.includes(char)) {
      regex += `\\${char}`;
      continue;
    }

    regex += char;
  }

  regex += '$';
  return new RegExp(regex);
}

export function parseManifest(raw) {
  const rules = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = trimmed.match(/^(include|exclude)\s+(.+)$/);
    if (!match) {
      throw new Error(`Invalid manifest line: ${line}`);
    }

    rules.push({
      action: match[1],
      pattern: match[2],
      regex: globToRegExp(match[2])
    });
  }

  if (rules.length === 0) {
    throw new Error('Manifest contains no rules.');
  }

  return rules;
}

export function classifyPath(path, rules) {
  for (const rule of rules) {
    if (rule.regex.test(path)) {
      return rule.action;
    }
  }

  return 'unclassified';
}

export function classifyPaths(paths, rules) {
  const approved = [];
  const excluded = [];
  const unclassified = [];

  for (const path of paths) {
    const decision = classifyPath(path, rules);
    if (decision === 'include') {
      approved.push(path);
    } else if (decision === 'exclude') {
      excluded.push(path);
    } else {
      unclassified.push(path);
    }
  }

  return { approved, excluded, unclassified };
}

export function listSourcePaths(sourceSha, repositoryRoot = join(scriptDirectory, '..')) {
  const output = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', sourceSha],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  return parseManifest(readFileSync(manifestPath, 'utf8'));
}

export function listTreePaths(treeSha, repositoryRoot = join(scriptDirectory, '..')) {
  const output = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', treeSha],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function classifySourceTree(sourceSha, options = {}) {
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const repositoryRoot = options.repositoryRoot ?? join(scriptDirectory, '..');
  const rules = loadManifest(manifestPath);
  const paths = listSourcePaths(sourceSha, repositoryRoot);
  return classifyPaths(paths, rules);
}

export function validateTreePaths(treeSha, options = {}) {
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const repositoryRoot = options.repositoryRoot ?? join(scriptDirectory, '..');
  const rules = loadManifest(manifestPath);
  const paths = listTreePaths(treeSha, repositoryRoot);
  return classifyPaths(paths, rules);
}

function printUsage() {
  console.error('Usage: public-release-classify.js [--source-sha <sha>] [--validate-tree <tree-sha>] [--manifest <path>] [--list-approved|--json]');
}

function main() {
  const args = process.argv.slice(2);
  let sourceSha = 'HEAD';
  let treeSha = '';
  let manifestPath = DEFAULT_MANIFEST_PATH;
  let outputMode = 'json';

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--source-sha') {
      sourceSha = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--validate-tree') {
      treeSha = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--manifest') {
      manifestPath = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--list-approved') {
      outputMode = 'approved';
      continue;
    }
    if (arg === '--json') {
      outputMode = 'json';
      continue;
    }

    printUsage();
    process.exit(1);
  }

  const repositoryRoot = join(scriptDirectory, '..');

  if (treeSha) {
    const resolvedTree = execFileSync('git', ['rev-parse', treeSha], {
      cwd: repositoryRoot,
      encoding: 'utf8'
    }).trim();
    const result = validateTreePaths(resolvedTree, { manifestPath });
    if (result.unclassified.length > 0 || result.excluded.length > 0) {
      for (const path of result.excluded) {
        console.error(`Excluded path present in tree: ${path}`);
      }
      for (const path of result.unclassified) {
        console.error(`Unclassified path present in tree: ${path}`);
      }
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({
      treeSha: resolvedTree,
      manifestPath,
      approvedCount: result.approved.length
    }, null, 2));
    process.stdout.write('\n');
    return;
  }

  const resolvedSha = execFileSync('git', ['rev-parse', sourceSha], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  }).trim();

  const result = classifySourceTree(resolvedSha, { manifestPath });
  if (result.unclassified.length > 0) {
    console.error('Unclassified paths detected:');
    for (const path of result.unclassified) {
      console.error(`  ${path}`);
    }
    process.exit(1);
  }

  if (outputMode === 'approved') {
    for (const path of result.approved) {
      console.log(path);
    }
    return;
  }

  process.stdout.write(JSON.stringify({
    sourceSha: resolvedSha,
    manifestPath,
    approvedCount: result.approved.length,
    excludedCount: result.excluded.length,
    approved: result.approved,
    excluded: result.excluded
  }, null, 2));
  process.stdout.write('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
