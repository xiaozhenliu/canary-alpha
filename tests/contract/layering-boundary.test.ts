import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Architectural layering guardrail (tech-debt TD-003).
 *
 * The service layer (`src/services/**`) is the lowest application layer and
 * must never depend "upward" on the orchestration / delivery layers:
 *
 *   - `src/mcp/tools/**`   (MCP tool handlers)
 *   - `src/transports/**`  (stdio / HTTP transports)
 *   - `src/bootstrap/**`   (composition root)
 *
 * Dependencies must flow downward only (tools/transports/bootstrap import
 * services, not the reverse). Until now this was enforced by convention and
 * code review alone; this test makes it an automated boundary, mirroring the
 * `git grep`-based capture-provider boundary in `capture-boundary.test.ts` but
 * resolving relative specifiers so that intra-service names which merely
 * contain a layer word (e.g. `bootstrap-status-service.ts`) are not
 * false-positives.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVICES_DIR = join(REPO_ROOT, 'src', 'services');

// Repo-relative (POSIX) path prefixes the service layer may not import from.
const FORBIDDEN_LAYER_PREFIXES = [
  'src/mcp/tools',
  'src/transports',
  'src/bootstrap'
];

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTypeScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(fullPath);
    }
  }
  return out;
}

/**
 * Extract module specifiers from every import form that can cross a layer
 * boundary:
 *   - `... from '<spec>'`            (named / default / namespace / re-export)
 *   - `import('<spec>')`             (dynamic import)
 *   - `import '<spec>'`              (side-effect-only import — no `from`)
 */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    specifiers.push((match[1] ?? match[2] ?? match[3]) as string);
  }
  return specifiers;
}

function toPosix(value: string): string {
  return value.replaceAll('\\', '/');
}

describe('layering boundary: service layer must not depend upward', () => {
  const serviceFiles = listTypeScriptFiles(SERVICES_DIR);

  it('discovers service-layer source files to scan', () => {
    expect(serviceFiles.length).toBeGreaterThan(0);
  });

  it('no src/services/** file imports mcp/tools, transports, or bootstrap', () => {
    const offenders: string[] = [];

    for (const file of serviceFiles) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        // Only relative, intra-repo imports can cross internal layer boundaries.
        if (!specifier.startsWith('.')) {
          continue;
        }
        const resolved = toPosix(relative(REPO_ROOT, resolve(dirname(file), specifier)));
        const crossesBoundary = FORBIDDEN_LAYER_PREFIXES.some(
          (prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`)
        );
        if (crossesBoundary) {
          offenders.push(`${toPosix(relative(REPO_ROOT, file))} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
