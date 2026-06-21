---
doc_version: 1
doc_status: active
last_updated: 2026-06-21
---

# Internal Release Workflow

This document defines how development changes move to the public repository. The executable source of truth
is `scripts/publish-to-public.sh`; do not maintain a second manual merge procedure in agent instructions.

## Branch Roles

- `dev` is the active development branch. Daily work and feature branches target it.
- `public-main` is the local public-release branch. It receives reviewed changes from `dev` after private and
  development-only files have been removed from the release tree.
- local `main` is a historical archive and does not receive new development.
- remote `public/main` is the published public branch.

## Release Commands

Run from a clean `dev` worktree:

```bash
npm run release:public:dry-run
npm run release:public
```

The dry run performs the merge and validation locally, then restores the original branch state. Run the real
release only after the dry run succeeds.

## Script Guarantees

`scripts/publish-to-public.sh`:

1. verifies the current branch, release branch, remote, and worktree state;
2. derives private paths from `public-main`'s `.gitignore` rather than duplicating a path list;
3. merges `dev` into `public-main` and removes private paths from the release tree;
4. validates the staged and committed trees for private-content leaks;
5. commits the release merge, pushes it to `public/main`, and returns to `dev`;
6. rolls back failed or dry-run execution and restores any dry-run auto-stash.

If the script and this explanation differ, follow the script and update this document.
