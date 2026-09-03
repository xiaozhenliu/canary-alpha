---
doc_version: 6
doc_status: active
last_updated: 2026-09-04
---

# Internal Release Workflow

This document defines how development changes move to the public repository. The executable source of truth
is `scripts/publish-to-public.sh`; do not maintain a second manual merge procedure in agent instructions.

## Branch Roles

- `dev` is the active development branch. Daily work and feature branches target it.
- `public-main` is the local public-release branch. It receives filtered snapshots from a committed `dev` SHA.
- local `main` is a historical archive and does not receive new development.
- remote `public/main` is the published public branch.

## Release Commands

Run from a clean `dev` worktree:

```bash
npm run release:public:dry-run
npm run release:public
```

Dry run builds and validates a filtered public candidate locally, records the verified commit and tree hashes
under `.codex-review/public-release-candidate.json`, and leaves branches, remotes, tags, and the working tree
unchanged. Real release must consume the same source SHA and manifest version recorded by dry run.

For a one-time clean-root rewrite candidate:

```bash
bash scripts/prepare-public-history-rewrite.sh
```

## Script Guarantees

`scripts/publish-to-public.sh`:

1. verifies the current branch, release branch, remote, and worktree state;
2. reads an explicit source SHA from committed `dev` history; uncommitted working-tree content cannot participate;
3. classifies every source path through `scripts/public-release-manifest.txt` and fails closed on unclassified paths;
4. builds a filtered tree from the source SHA without merging `dev` into `public-main`;
5. requires local `public-main` to match remote `public/main` (via `git ls-remote`, without updating remote-tracking
   refs), then creates a public-only commit whose direct parent is that verified tip, or a root commit when
   `--root` is used for history rewrite candidates;
6. validates the candidate tree, commit graph, a fresh worktree checkout of the candidate, and reachable history with Gitleaks (required);
7. records the verified candidate hash for dry run and pushes only on real release;
8. restores the original branch state after failed or dry-run execution.

Gitleaks is a required release dependency. Install it before dry run or real release; the script fails closed when it is missing.

The legacy `git merge dev --no-ff` publish flow is forbidden. If the script and this document differ, follow the
script and update this document in the same change.

## Public Manifest (Strict Allowlist Principle)

`scripts/public-release-manifest.txt` is the authoritative allow/deny list for public releases. It is independent of
`.gitignore`.

Public release operates strictly on an **allowlist-only (white-list) philosophy**:
- Only paths matching explicit `include` directives are published.
- Deny-lists (`exclude`) exist only to classify internal development paths so the classifier can verify full repository coverage and fail closed on unclassified files. Deny-listing must **never** be relied upon as a primary safety mechanism.
- The following three categories are **strictly confidential / internal-only** and must never be published to public releases:
  1. **Vulnerabilities & defect reports:** Internal bug reports (`docs/engineering/bug-reports/**`), internal security audits and conventions (`docs/security/**`), and structural technical debt lists (`docs/engineering/tech-debt.md`). Only the standard public reporting policy (`SECURITY.md`) is public.
  2. **Agent collaboration & internal workflows:** Agent instructions and prompts (`AGENTS.md`, `CLAUDE.md`), workflow state (`STATE.md`, `PRD_*`), workspace metadata (`.agents/**`, `.kiro/**`, `docs/agents/**`, `.scratch/**`, `.understand-anything/**`).
  3. **Future roadmaps, backlogs & draft specs:** Unreleased roadmap pools (`docs/specs/future-backlog.md`, `docs/specs/README.md`), draft specifications, and competitive/exploratory research documents. Only completed, delivered public feature specifications may be included.

Confirmed synthetic test-fixture Gitleaks findings must be recorded in
`scripts/public-release-gitleaks-allowlist.txt` by fingerprint. Unexpected findings still fail closed.

## One-Time Public History Rewrite

When old `public/main` history still contains development-only paths or merge commits with `dev` parents:

1. record remote branch and tag SHAs locally;
2. create a local recovery branch;
3. generate a clean-root candidate with `scripts/prepare-public-history-rewrite.sh`;
4. verify the candidate tree, manifest coverage, and credential scan;
5. push with `--force-with-lease` only after human approval.

Copies outside repository control, including forks, clones, mirrors, and caches, cannot be fully recalled. Record
remaining exposure in `.codex-review/public-history-rewrite/` and continue with the corrected future release flow.
