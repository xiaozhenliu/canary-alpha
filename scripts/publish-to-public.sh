#!/usr/bin/env bash
# publish-to-public.sh
# Merge dev into public-main and push to remote public/main.
# Validates that no private/dev-only content leaks into the public branch.
#
# Usage:
#   ./scripts/publish-to-public.sh              # full run (merge + push)
#   ./scripts/publish-to-public.sh --dry-run    # merge locally, validate, then rollback

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────────────

DEV_BRANCH="dev"
PUBLIC_BRANCH="public-main"
REMOTE_NAME="public"
REMOTE_REF="main"

# ── Colors ─────────────────────────────────────────────────────────────────────

GRN='\033[0;32m'; RED='\033[0;31m'; CYA='\033[0;36m'; YEL='\033[0;33m'; OFF='\033[0m'
step()  { echo -e "\n${CYA}==> $*${OFF}"; }
ok()    { echo -e "${GRN}  ✔ $*${OFF}"; }
fail()  { echo -e "${RED}  ✘ $*${OFF}"; }
warn()  { echo -e "${YEL}  ⚠ $*${OFF}"; }

# Check if a tree listing contains files matching a private pattern.
# Uses pure shell matching to avoid regex metacharacter issues.
# Supports: "dir/" (root dir), "file.md" (root file), "**/dir/" (recursive dir),
# "**/FILE.md" and "**/*GLOB*" (recursive glob).
tree_contains_pattern() {
  local listing="$1" pattern="$2"
  local clean="${pattern%/}"
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    if [[ "$pattern" == \*\*/* ]]; then
      # Recursive pattern: match basename or any path segment.
      # Strip **/ prefix, then check if any path component matches.
      local suffix="${pattern#\*\*/}"
      local suffix_clean="${suffix%/}"
      if [[ "$suffix" == */ ]]; then
        # Recursive directory: e.g. **/plans/ — match "plans/" anywhere in path
        [[ "$path" == *"${suffix_clean}/"* || "$path" == "${suffix_clean}/"* ]] && return 0
      else
        # Recursive file glob: e.g. **/*_PLAN.md — match against basename
        local basename="${path##*/}"
        # shellcheck disable=SC2053
        [[ "$basename" == $suffix_clean ]] && return 0
      fi
    elif [[ "$pattern" == */ ]]; then
      # Root directory pattern: match paths starting with "dir/"
      [[ "$path" == "${clean}/"* ]] && return 0
    else
      # Root file pattern: exact match
      [[ "$path" == "$clean" ]] && return 0
    fi
  done <<< "$listing"
  return 1
}

# ── Argument parsing (fail-closed on unknown args) ─────────────────────────────

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *)
      fail "Unknown argument: $arg"
      echo "Usage: $0 [--dry-run]"
      exit 1
      ;;
  esac
done

if $DRY_RUN; then
  warn "Dry-run mode: will merge and validate locally, then rollback."
fi

# ── State tracking for cleanup ─────────────────────────────────────────────────

STASHED=false
SWITCHED=false
MERGE_IN_PROGRESS=false
COMMITTED=false
PUBLIC_HEAD_BEFORE=""
ORIGINAL_BRANCH="$DEV_BRANCH"

cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]] || { $DRY_RUN && $COMMITTED; }; then
    # Abort any in-progress merge.
    if $MERGE_IN_PROGRESS; then
      git merge --abort 2>/dev/null || true
      MERGE_IN_PROGRESS=false
    fi
    # Reset public-main to its original state if we committed.
    if $COMMITTED && [[ -n "$PUBLIC_HEAD_BEFORE" ]]; then
      git reset --hard "$PUBLIC_HEAD_BEFORE" --quiet 2>/dev/null || true
      COMMITTED=false
    fi
  fi
  # Return to original branch.
  local current
  current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
  if $SWITCHED && [[ "$current" != "$ORIGINAL_BRANCH" ]]; then
    git checkout "$ORIGINAL_BRANCH" --quiet 2>/dev/null || true
  fi
  # Restore stashed changes.
  if $STASHED; then
    git stash pop --index --quiet 2>/dev/null || {
      warn "Could not restore auto-stashed changes. Run 'git stash pop' manually."
    }
    STASHED=false
  fi
}
trap cleanup EXIT

# ── Build private patterns from public-main .gitignore ─────────────────────────

# Extract concrete path patterns (not globs with *, not negations, not comments)
# from public-main's .gitignore. These are the files/dirs that must not appear
# in the public tree. We read them dynamically so the script stays in sync
# with .gitignore changes without manual updates.
build_private_patterns() {
  local gitignore_content
  gitignore_content="$(git show "${PUBLIC_BRANCH}:.gitignore" 2>/dev/null || echo "")"
  if [[ -z "$gitignore_content" ]]; then
    fail "Cannot read .gitignore from $PUBLIC_BRANCH"
    exit 1
  fi

  PRIVATE_PATTERNS=()
  while IFS= read -r line; do
    # Skip empty lines, comments, and negations.
    [[ -z "$line" ]] && continue
    [[ "$line" == \#* ]] && continue
    [[ "$line" == \!* ]] && continue
    # Skip generic dev/build artifacts (not project-specific private content).
    case "$line" in
      node_modules/|dist/|build/|coverage/|.DS_Store|tmp/|.tmp/|.cache/|.dist/) continue ;;
      .env|.env.*) continue ;;
      .test-tmp/|.worktrees/|.mcp.json) continue ;;
    esac
    # Skip single-extension wildcards (*.log, *.db, etc.) — these are build artifacts.
    if [[ "$line" == \*.* ]] && [[ "$line" != \*\*/* ]]; then continue; fi
    # Skip log-specific wildcards.
    case "$line" in
      npm-debug.log*|pnpm-debug.log*|yarn-debug.log*|yarn-error.log*) continue ;;
    esac
    PRIVATE_PATTERNS+=("$line")
  done <<< "$gitignore_content"

  if [[ ${#PRIVATE_PATTERNS[@]} -eq 0 ]]; then
    fail "No private patterns extracted from .gitignore — safety check failed."
    exit 1
  fi
}

# ── Pre-flight checks ─────────────────────────────────────────────────────────

step "Pre-flight checks"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "$DEV_BRANCH" ]]; then
  fail "Must run from the '$DEV_BRANCH' branch (currently on '$CURRENT_BRANCH')."
  exit 1
fi
ORIGINAL_BRANCH="$CURRENT_BRANCH"
ok "On branch $DEV_BRANCH"

if [[ -n "$(git status --porcelain)" ]]; then
  if $DRY_RUN; then
    warn "Working tree is dirty — auto-stashing for dry-run."
    git stash push --include-untracked --quiet -m "publish-dry-run-auto-stash"
    STASHED=true
  else
    fail "Working tree is dirty. Commit or stash changes first."
    exit 1
  fi
fi
ok "Working tree $($STASHED && echo 'auto-stashed' || echo 'clean')"

if ! git rev-parse --verify "$PUBLIC_BRANCH" >/dev/null 2>&1; then
  fail "Branch '$PUBLIC_BRANCH' does not exist locally."
  exit 1
fi
ok "Branch $PUBLIC_BRANCH exists"

if ! git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  fail "Remote '$REMOTE_NAME' is not configured."
  exit 1
fi
ok "Remote $REMOTE_NAME configured"

build_private_patterns
ok "Private patterns (${#PRIVATE_PATTERNS[@]}): ${PRIVATE_PATTERNS[*]}"

DEV_HEAD="$(git rev-parse HEAD)"
ok "dev HEAD: ${DEV_HEAD:0:8}"

# ── Switch to public-main and merge ───────────────────────────────────────────

step "Switching to $PUBLIC_BRANCH"
git checkout "$PUBLIC_BRANCH" --quiet
SWITCHED=true
PUBLIC_HEAD_BEFORE="$(git rev-parse HEAD)"

step "Merging $DEV_BRANCH into $PUBLIC_BRANCH (--no-commit --no-ff)"
MERGE_EXIT=0
MERGE_OUTPUT="$(git merge "$DEV_BRANCH" --no-commit --no-ff 2>&1)" || MERGE_EXIT=$?

if echo "$MERGE_OUTPUT" | grep -q "Already up to date"; then
  # Check if there are historical private files to clean up.
  HISTORICAL_LEAK=false
  HEAD_LISTING="$(git ls-tree -r --name-only HEAD)"
  for pattern in "${PRIVATE_PATTERNS[@]}"; do
    if tree_contains_pattern "$HEAD_LISTING" "$pattern"; then
      HISTORICAL_LEAK=true
      break
    fi
  done
  if ! $HISTORICAL_LEAK; then
    ok "Already up to date and no historical leaks to clean."
    exit 0
  fi
  warn "Already up to date but found historical private files to clean up."
elif [[ $MERGE_EXIT -ne 0 ]]; then
  if echo "$MERGE_OUTPUT" | grep -qi "conflict\|CONFLICT"; then
    MERGE_IN_PROGRESS=true
    warn "Merge produced conflicts (expected for dev-only files). Resolving..."
  else
    fail "Merge failed unexpectedly:"
    echo "$MERGE_OUTPUT"
    exit 1
  fi
else
  MERGE_IN_PROGRESS=true
fi

# ── Remove dev-only files from index ───────────────────────────────────────────

step "Removing private files from git index"
for pattern in "${PRIVATE_PATTERNS[@]}"; do
  if git ls-files --stage -- "$pattern" | grep -q .; then
    git rm -r --cached --quiet -- "$pattern" 2>/dev/null || true
    ok "Removed from index: $pattern"
  fi
done

# Restore public-main's own .gitignore.
git checkout HEAD -- .gitignore 2>/dev/null || true
ok "Restored $PUBLIC_BRANCH .gitignore"

# ── Validate: no private content in the would-be commit tree ──────────────────

step "Validating: no private content in the would-be commit tree"
LEAK_FOUND=false

TREE="$(git write-tree 2>/dev/null || echo "")"
if [[ -z "$TREE" ]]; then
  fail "Could not write tree from index."
  exit 1
fi

TREE_LISTING="$(git ls-tree -r --name-only "$TREE")"
for pattern in "${PRIVATE_PATTERNS[@]}"; do
  if tree_contains_pattern "$TREE_LISTING" "$pattern"; then
    fail "LEAK DETECTED in tree: $pattern"
    LEAK_FOUND=true
  fi
done

if $LEAK_FOUND; then
  fail "Private content detected! Aborting merge."
  exit 1
fi
ok "No private content in commit tree"

# ── Validate: .gitignore contains all private patterns ─────────────────────────

step "Validating .gitignore coverage"
# Read non-comment, non-empty lines from .gitignore for matching.
GITIGNORE_LINES="$(grep -v '^#' .gitignore | grep -v '^$' || true)"
for pattern in "${PRIVATE_PATTERNS[@]}"; do
  clean="${pattern%/}"
  if ! echo "$GITIGNORE_LINES" | grep -qxF "$clean" && \
     ! echo "$GITIGNORE_LINES" | grep -qxF "${clean}/"; then
    fail ".gitignore missing exact pattern: $clean"
    LEAK_FOUND=true
  fi
done

if $LEAK_FOUND; then
  fail ".gitignore is incomplete! Aborting."
  exit 1
fi
ok ".gitignore covers all private patterns"

# ── Check if there are actual changes to commit ───────────────────────────────

if git diff --cached --quiet; then
  warn "No changes to commit after merge (public-main is already up to date)."
  git merge --abort 2>/dev/null || true
  MERGE_IN_PROGRESS=false
  exit 0
fi

# ── Commit ─────────────────────────────────────────────────────────────────────

step "Committing merge"
COMMIT_MSG="merge: integrate dev changes for release

Source: ${DEV_HEAD:0:8} ($DEV_BRANCH)
Target: ${PUBLIC_HEAD_BEFORE:0:8} ($PUBLIC_BRANCH)"

git commit -m "$COMMIT_MSG" --quiet
MERGE_IN_PROGRESS=false
COMMITTED=true
MERGE_COMMIT="$(git rev-parse HEAD)"
ok "Merge commit: ${MERGE_COMMIT:0:8}"

# ── Clean working directory ────────────────────────────────────────────────────

step "Cleaning private files from working directory"
for pattern in "${PRIVATE_PATTERNS[@]}"; do
  if [[ -e "$pattern" ]]; then
    # Use -fdX to clean ignored files, -fd for untracked.
    git clean -fdX --quiet -- "$pattern" 2>/dev/null || \
    git clean -fd --quiet -- "$pattern" 2>/dev/null || true
    ok "Cleaned: $pattern"
  fi
done

# ── Post-commit validation ─────────────────────────────────────────────────────

step "Post-commit tree validation"
FINAL_TREE="$(git rev-parse "HEAD^{tree}")"
FINAL_LISTING="$(git ls-tree -r --name-only "$FINAL_TREE")"
POST_LEAK=false
for pattern in "${PRIVATE_PATTERNS[@]}"; do
  if tree_contains_pattern "$FINAL_LISTING" "$pattern"; then
    fail "POST-COMMIT LEAK: $pattern found in final tree!"
    POST_LEAK=true
  fi
done

if $POST_LEAK; then
  fail "Post-commit validation failed! Rolling back."
  exit 1
fi
ok "Final commit tree is clean"

# ── Dry-run: rollback ─────────────────────────────────────────────────────────

if $DRY_RUN; then
  step "Dry-run: rolling back merge commit"
  git reset --hard "$PUBLIC_HEAD_BEFORE" --quiet
  COMMITTED=false
  git checkout "$DEV_BRANCH" --quiet
  SWITCHED=false
  if $STASHED; then
    git stash pop --index --quiet
    STASHED=false
    ok "Restored auto-stashed changes"
  fi
  ok "Rolled back $PUBLIC_BRANCH to ${PUBLIC_HEAD_BEFORE:0:8}"
  ok "Dry-run complete. All validations passed."
  exit 0
fi

# ── Push ───────────────────────────────────────────────────────────────────────

step "Pushing $PUBLIC_BRANCH to $REMOTE_NAME/$REMOTE_REF"
git push "$REMOTE_NAME" "$PUBLIC_BRANCH:$REMOTE_REF"
COMMITTED=false  # Push succeeded; don't rollback in cleanup.
ok "Pushed successfully"

# ── Return to dev ──────────────────────────────────────────────────────────────

step "Switching back to $DEV_BRANCH"
git checkout "$DEV_BRANCH" --quiet
SWITCHED=false
ok "Back on $DEV_BRANCH"

echo -e "\n${GRN}✅ Published ${DEV_HEAD:0:8} → $REMOTE_NAME/$REMOTE_REF (commit ${MERGE_COMMIT:0:8})${OFF}"
