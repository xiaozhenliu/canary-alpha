import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Architectural boundary: Screenpipe-specific knowledge may only appear in
 * the provider directory, the config layer (env-var mapping / paths), and
 * the screenpipe-specific diagnostics module. Everything else must speak
 * the neutral capture model.
 */
const ALLOWED_PATH_PREFIXES = [
  'src/services/capture/providers/screenpipe/',
  'src/config/',                         // env mapping + .screenpipe dir constant
  'src/services/diagnostics/',           // screenpipe-specific storage diagnostics
  'src/services/privacy/',               // delete-range targets the upstream db path
  'src/mcp/tools/screenpipe-control.ts', // provider-named tool, registered conditionally
  // Assembly point: the factory is the single place allowed to wire Screenpipe-specific
  // config fields (config.screenpipe.url / .apiKey) to the provider implementations.
  // Matching only the exact file avoids widening the entire src/services/capture/ tree.
  'src/services/capture/provider-factory.ts',
  // capture/types.ts contains a comment that quotes `=== 'screenpipe'` as an example
  // of the anti-pattern to avoid. The git-grep pattern matches the comment verbatim.
  'src/services/capture/types.ts'
];

const FORBIDDEN_PATTERNS = [
  'FROM frames',            // upstream SQLite schema knowledge
  // Upstream data directory (`~/.screenpipe`). The trailing guard keeps identifier
  // names such as `.screenpipeStorage` from matching —
  // those are neutral-layer property names, not directory knowledge.
  "\\.screenpipe([^A-Za-z]|$)",
  'screenpipe-safe-record', // provider process script
  "=== 'screenpipe'"        // provider-name branching (use capabilities instead)
];

function gitGrep(pattern: string): string[] {
  try {
    const out = execFileSync(
      'git', ['grep', '-l', '-E', pattern, '--', 'src/**/*.ts'],
      { encoding: 'utf8' }
    );
    return out.split('\n').filter(Boolean);
  } catch {
    return []; // git grep exits 1 on zero matches
  }
}

describe('capture provider boundary', () => {
  for (const pattern of FORBIDDEN_PATTERNS) {
    it(`confines "${pattern}" to the provider/config/diagnostics layers`, () => {
      const offenders = gitGrep(pattern).filter(
        (file) => !ALLOWED_PATH_PREFIXES.some((prefix) => file.startsWith(prefix))
      );
      expect(offenders).toEqual([]);
    });
  }
});
