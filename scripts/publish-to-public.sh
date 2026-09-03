#!/usr/bin/env bash
# publish-to-public.sh
# Build a filtered public-only commit from a committed dev SHA and optional push.
#
# Usage:
#   ./scripts/publish-to-public.sh [--dry-run] [--source-sha <sha>] [--root]
#   ./scripts/publish-to-public.sh --consume-candidate <commit-sha>

set -euo pipefail

DEV_BRANCH="dev"
PUBLIC_BRANCH="public-main"
REMOTE_NAME="public"
REMOTE_REF="main"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLASSIFIER="$SCRIPT_DIR/public-release-classify.js"
MANIFEST_PATH="$SCRIPT_DIR/public-release-manifest.txt"
GITLEAKS_ALLOWLIST="$SCRIPT_DIR/public-release-gitleaks-allowlist.txt"
CANDIDATE_RECORD="$REPO_ROOT/.codex-review/public-release-candidate.json"

GRN='\033[0;32m'; RED='\033[0;31m'; CYA='\033[0;36m'; YEL='\033[0;33m'; OFF='\033[0m'
step()  { echo -e "\n${CYA}==> $*${OFF}"; }
ok()    { echo -e "${GRN}  ✔ $*${OFF}"; }
fail()  { echo -e "${RED}  ✘ $*${OFF}"; }
warn()  { echo -e "${YEL}  ⚠ $*${OFF}"; }

DRY_RUN=false
SOURCE_SHA=""
ROOT_COMMIT=false
CONSUME_CANDIDATE=""

args=("$@")
index=0
while [[ $index -lt ${#args[@]} ]]; do
  case "${args[$index]}" in
    --dry-run)
      DRY_RUN=true
      index=$((index + 1))
      ;;
    --root)
      ROOT_COMMIT=true
      index=$((index + 1))
      ;;
    --source-sha)
      SOURCE_SHA="${args[$((index + 1))]:-}"
      if [[ -z "$SOURCE_SHA" ]]; then
        fail "--source-sha requires a value"
        exit 1
      fi
      index=$((index + 2))
      ;;
    --consume-candidate)
      CONSUME_CANDIDATE="${args[$((index + 1))]:-}"
      if [[ -z "$CONSUME_CANDIDATE" ]]; then
        fail "--consume-candidate requires a value"
        exit 1
      fi
      index=$((index + 2))
      ;;
    *)
      fail "Unknown argument: ${args[$index]}"
      echo "Usage: $0 [--dry-run] [--source-sha <sha>] [--root] [--consume-candidate <commit-sha>]"
      exit 1
      ;;
  esac
done

ORIGINAL_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
STASHED=false
CREATED_COMMIT=""
PUBLIC_HEAD_BEFORE=""
TEMP_INDEX=""

cleanup() {
  local exit_code=$?
  if [[ -n "$TEMP_INDEX" && -f "$TEMP_INDEX" ]]; then
    rm -f "$TEMP_INDEX"
  fi

  if [[ -n "$CREATED_COMMIT" ]] && { [[ $exit_code -ne 0 ]] || $DRY_RUN; }; then
    if git rev-parse --verify "$PUBLIC_BRANCH" >/dev/null 2>&1 && [[ -n "$PUBLIC_HEAD_BEFORE" ]]; then
      git branch -f "$PUBLIC_BRANCH" "$PUBLIC_HEAD_BEFORE" >/dev/null 2>&1 || true
    fi
  fi

  if [[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")" != "$ORIGINAL_BRANCH" ]]; then
    git checkout "$ORIGINAL_BRANCH" --quiet 2>/dev/null || true
  fi

  if $STASHED; then
    git stash pop --index --quiet 2>/dev/null || warn "Could not restore auto-stashed changes. Run 'git stash pop' manually."
  fi
}
trap cleanup EXIT

validate_commit_graph() {
  local candidate="$1"
  local parents
  parents="$(git rev-list --parents -n 1 "$candidate" | awk '{$1=""; print $0}' | xargs || true)"

  if $ROOT_COMMIT; then
    if [[ -n "$parents" ]]; then
      fail "Root candidate must have no parents, found: $parents"
      exit 1
    fi
    ok "Candidate is a root commit"
    return
  fi

  if [[ -z "$parents" ]]; then
    fail "Candidate must have exactly one parent (public-main), found none."
    exit 1
  fi

  local parent_count
  parent_count="$(wc -w <<< "$parents" | tr -d ' ')"
  if [[ "$parent_count" -ne 1 ]]; then
    fail "Candidate must have exactly one parent, found: $parents"
    exit 1
  fi

  if [[ "$parents" != "$PUBLIC_HEAD_BEFORE" ]]; then
    fail "Candidate parent ($parents) does not match public-main ($PUBLIC_HEAD_BEFORE)."
    exit 1
  fi

  if [[ "$parents" == "$RESOLVED_SOURCE_SHA" ]]; then
    fail "Source dev SHA must not be a direct parent of the public candidate."
    exit 1
  fi

  ok "Candidate commit graph is public-only (parent=${parents:0:8})"
}

scan_candidate_tree() {
  local tree_sha="$1"
  step "Validating candidate tree against manifest"
  local manifest_file
  manifest_file="$(mktemp)"
  git show "$RESOLVED_SOURCE_SHA:scripts/public-release-manifest.txt" > "$manifest_file"
  if ! node "$CLASSIFIER" --validate-tree "$tree_sha" --manifest "$manifest_file" >/dev/null; then
    rm -f "$manifest_file"
    fail "Candidate tree validation failed"
    exit 1
  fi
  rm -f "$manifest_file"
  ok "Candidate tree matches manifest"
}

verify_fresh_checkout() {
  local candidate="$1"
  local tree_sha="$2"
  step "Verifying fresh checkout of candidate ${candidate:0:8}"
  local verify_dir
  verify_dir="$(mktemp -d "${TMPDIR:-/tmp}/public-release-checkout.XXXXXX")"
  if ! git worktree add --detach "$verify_dir" "$candidate" >/dev/null 2>&1; then
    rm -rf "$verify_dir"
    fail "Unable to create a fresh worktree checkout of candidate $candidate"
    exit 1
  fi

  local checked_tree
  checked_tree="$(git -C "$verify_dir" rev-parse 'HEAD^{tree}')"
  if [[ "$checked_tree" != "$tree_sha" ]]; then
    git worktree remove --force "$verify_dir" >/dev/null 2>&1 || rm -rf "$verify_dir"
    fail "Fresh checkout tree $checked_tree does not match candidate tree $tree_sha"
    exit 1
  fi

  local manifest_file
  manifest_file="$(mktemp)"
  git show "$RESOLVED_SOURCE_SHA:scripts/public-release-manifest.txt" > "$manifest_file"
  if ! node "$CLASSIFIER" --validate-tree "$checked_tree" --manifest "$manifest_file" >/dev/null; then
    rm -f "$manifest_file"
    git worktree remove --force "$verify_dir" >/dev/null 2>&1 || rm -rf "$verify_dir"
    fail "Fresh checkout failed manifest path validation"
    exit 1
  fi
  rm -f "$manifest_file"

  if ! git worktree remove --force "$verify_dir" >/dev/null 2>&1; then
    rm -rf "$verify_dir"
  fi
  ok "Fresh checkout of candidate passed path validation"
}

run_gitleaks_if_available() {
  local candidate="$1"
  if ! command -v gitleaks >/dev/null 2>&1; then
    fail "gitleaks is required for public release credential scanning"
    exit 1
  fi

  step "Scanning candidate reachable history with gitleaks"
  local log_opts="$candidate"

  local report
  report="$(mktemp)"
  local status=0
  gitleaks detect --no-banner --log-opts "$log_opts" --report-format json --report-path "$report" || status=$?

  if [[ $status -eq 0 ]]; then
    rm -f "$report"
    ok "Gitleaks scan passed"
    return 0
  fi

  # Gitleaks uses exit code 1 for leaks found. Any other non-zero is a scanner failure.
  if [[ $status -ne 1 ]]; then
    fail "Gitleaks failed with exit code $status"
    cat "$report" || true
    rm -f "$report"
    exit 1
  fi

  if [[ ! -f "$GITLEAKS_ALLOWLIST" ]]; then
    fail "Gitleaks reported findings and no allowlist exists at $GITLEAKS_ALLOWLIST"
    cat "$report" || true
    rm -f "$report"
    exit 1
  fi

  local unexpected=""
  if ! unexpected="$(node "$SCRIPT_DIR/public-release-gitleaks-filter.js" "$report" "$GITLEAKS_ALLOWLIST")"; then
    fail "Gitleaks reported unexpected findings:"
    echo "$unexpected"
    rm -f "$report"
    exit 1
  fi

  rm -f "$report"
  ok "Gitleaks findings match recorded test-fixture false positives"
}

build_filtered_tree() {
  local source_sha="$1"
  local manifest_file
  manifest_file="$(mktemp)"
  git show "$source_sha:scripts/public-release-manifest.txt" > "$manifest_file"
  ACTIVE_MANIFEST_PATH="$manifest_file"

  step "Classifying source tree at ${source_sha:0:8}"
  if ! node "$CLASSIFIER" --source-sha "$source_sha" --manifest "$ACTIVE_MANIFEST_PATH" --json >/tmp/public-release-classify.json; then
    rm -f "$manifest_file"
    fail "Source tree classification failed"
    exit 1
  fi
  ok "Classification passed ($(node -p "JSON.parse(require('fs').readFileSync('/tmp/public-release-classify.json','utf8')).approvedCount")) approved paths)"

  step "Building filtered tree from committed source"
  TEMP_INDEX="$(mktemp)"
  export GIT_INDEX_FILE="$TEMP_INDEX"
  git read-tree --empty

  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    while IFS=$'\t' read -r meta filepath; do
      read -r mode _object_type hash <<< "$meta"
      printf '%s %s 0\t%s\n' "$mode" "$hash" "$filepath" | git update-index --index-info
    done < <(git ls-tree "$source_sha" -- "$path")
  done < <(node "$CLASSIFIER" --source-sha "$source_sha" --manifest "$ACTIVE_MANIFEST_PATH" --list-approved)

  TREE_SHA="$(git write-tree)"
  unset GIT_INDEX_FILE
  rm -f "$TEMP_INDEX"
  TEMP_INDEX=""
  rm -f "$manifest_file"
  ACTIVE_MANIFEST_PATH=""
  ok "Filtered tree: ${TREE_SHA:0:8}"
}

record_candidate() {
  local commit_sha="$1"
  local tree_sha="$2"
  local manifest_blob
  manifest_blob="$(git rev-parse "$RESOLVED_SOURCE_SHA:scripts/public-release-manifest.txt")"
  mkdir -p "$(dirname "$CANDIDATE_RECORD")"
  cat > "$CANDIDATE_RECORD" <<EOF
{
  "sourceSha": "$RESOLVED_SOURCE_SHA",
  "candidateCommit": "$commit_sha",
  "candidateTree": "$tree_sha",
  "manifestPath": "scripts/public-release-manifest.txt",
  "manifestBlob": "$manifest_blob",
  "publicParent": "${PUBLIC_HEAD_BEFORE:-}",
  "rootCommit": $ROOT_COMMIT,
  "recordedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
  ok "Recorded candidate at $CANDIDATE_RECORD"
}

step "Pre-flight checks"

if [[ "$(git rev-parse --abbrev-ref HEAD)" != "$DEV_BRANCH" ]]; then
  fail "Must run from the '$DEV_BRANCH' branch."
  exit 1
fi
ok "On branch $DEV_BRANCH"

if [[ -n "$(git status --porcelain)" ]]; then
  if $DRY_RUN; then
    warn "Working tree is dirty — auto-stashing for dry-run."
    STASH_BEFORE="$(git stash list | wc -l | tr -d ' ')"
    git stash push --include-untracked --quiet -m "publish-dry-run-auto-stash"
    STASH_AFTER="$(git stash list | wc -l | tr -d ' ')"
    if [[ "$STASH_AFTER" -gt "$STASH_BEFORE" ]]; then
      STASHED=true
    else
      warn "No new stash entry was created; leaving existing user stash untouched."
    fi
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

if [[ ! -f "$MANIFEST_PATH" ]]; then
  fail "Missing manifest: $MANIFEST_PATH"
  exit 1
fi
ok "Manifest present"

PUBLIC_HEAD_BEFORE="$(git rev-parse "$PUBLIC_BRANCH")"
# Resolve the remote tip without updating remote-tracking refs so dry-run leaves
# local remotes unchanged while still refusing unpublished local public commits.
REMOTE_PUBLIC_HEAD="$(git ls-remote "$REMOTE_NAME" "refs/heads/$REMOTE_REF" | awk '{print $1}' || true)"
if [[ -z "$REMOTE_PUBLIC_HEAD" ]]; then
  fail "Unable to resolve remote tip $REMOTE_NAME/$REMOTE_REF via git ls-remote. Refusing to authenticate a public candidate without a live remote parent check."
  exit 1
fi
if [[ "$PUBLIC_HEAD_BEFORE" != "$REMOTE_PUBLIC_HEAD" ]]; then
  fail "Local $PUBLIC_BRANCH (${PUBLIC_HEAD_BEFORE:0:8}) differs from remote $REMOTE_NAME/$REMOTE_REF (${REMOTE_PUBLIC_HEAD:0:8}). Reset local $PUBLIC_BRANCH to the remote tip before publishing so unpublished local commits cannot become public ancestors."
  exit 1
fi
ok "Public parent matches remote $REMOTE_NAME/$REMOTE_REF (${PUBLIC_HEAD_BEFORE:0:8})"

RESOLVED_SOURCE_SHA="$(git rev-parse "${SOURCE_SHA:-HEAD}")"
SOURCE_TYPE="$(git cat-file -t "$RESOLVED_SOURCE_SHA")"
if [[ "$SOURCE_TYPE" != "commit" ]]; then
  fail "Source SHA must resolve to a commit object (got $SOURCE_TYPE)"
  exit 1
fi
if ! git merge-base --is-ancestor "$RESOLVED_SOURCE_SHA" "$DEV_BRANCH"; then
  fail "Source SHA ${RESOLVED_SOURCE_SHA:0:8} is not an ancestor of $DEV_BRANCH"
  exit 1
fi
HEAD_SHA="$(git rev-parse HEAD)"
if [[ "$RESOLVED_SOURCE_SHA" != "$HEAD_SHA" ]]; then
  fail "Source SHA must equal HEAD for release policy binding (source=${RESOLVED_SOURCE_SHA:0:8}, HEAD=${HEAD_SHA:0:8}). Checkout the reviewed commit before publishing."
  exit 1
fi
ok "Source SHA: ${RESOLVED_SOURCE_SHA:0:8}"
ok "Public parent: ${PUBLIC_HEAD_BEFORE:0:8}"

if ! $DRY_RUN && [[ -z "$CONSUME_CANDIDATE" ]]; then
  if [[ ! -f "$CANDIDATE_RECORD" ]]; then
    fail "Missing verified candidate record at $CANDIDATE_RECORD. Run npm run release:public:dry-run first."
    exit 1
  fi
  CONSUME_CANDIDATE="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).candidateCommit" "$CANDIDATE_RECORD")"
  RECORDED_SOURCE_SHA="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).sourceSha" "$CANDIDATE_RECORD")"
  RECORDED_ROOT="$(node -p "Boolean(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).rootCommit)" "$CANDIDATE_RECORD")"
  if [[ "$RESOLVED_SOURCE_SHA" != "$RECORDED_SOURCE_SHA" ]]; then
    fail "Source SHA drift: current ${RESOLVED_SOURCE_SHA:0:8} != recorded ${RECORDED_SOURCE_SHA:0:8}"
    exit 1
  fi
  if $ROOT_COMMIT && [[ "$RECORDED_ROOT" != "true" ]]; then
    fail "Root commit flag does not match recorded candidate"
    exit 1
  fi
  if ! $ROOT_COMMIT && [[ "$RECORDED_ROOT" == "true" ]]; then
    fail "Recorded candidate is a root commit; rerun with --root or regenerate the dry-run candidate"
    exit 1
  fi
  ok "Reusing verified candidate from $CANDIDATE_RECORD"
fi

if [[ -n "$CONSUME_CANDIDATE" ]]; then
  CANDIDATE_COMMIT="$(git rev-parse "$CONSUME_CANDIDATE")"
  CANDIDATE_TREE="$(git rev-parse "$CANDIDATE_COMMIT^{tree}")"
  step "Consuming verified candidate ${CANDIDATE_COMMIT:0:8}"
  build_filtered_tree "$RESOLVED_SOURCE_SHA"
  if [[ "$TREE_SHA" != "$CANDIDATE_TREE" ]]; then
    fail "Consumed candidate tree ${CANDIDATE_TREE:0:8} does not match rebuilt source tree ${TREE_SHA:0:8}"
    exit 1
  fi
  ok "Consumed candidate tree matches filtered source SHA tree"
else
  build_filtered_tree "$RESOLVED_SOURCE_SHA"
  CANDIDATE_TREE="$TREE_SHA"

  step "Creating public-only commit"
  COMMIT_MSG="release: filtered public snapshot

Source: ${RESOLVED_SOURCE_SHA}
Manifest: scripts/public-release-manifest.txt
Public parent: ${PUBLIC_HEAD_BEFORE}"

  if $ROOT_COMMIT; then
    CANDIDATE_COMMIT="$(git commit-tree "$CANDIDATE_TREE" -m "$COMMIT_MSG")"
  else
    CANDIDATE_COMMIT="$(git commit-tree "$CANDIDATE_TREE" -p "$PUBLIC_HEAD_BEFORE" -m "$COMMIT_MSG")"
  fi
  ok "Candidate commit: ${CANDIDATE_COMMIT:0:8}"
fi

if ! $DRY_RUN; then
  if [[ ! -f "$CANDIDATE_RECORD" ]]; then
    fail "Missing verified candidate record at $CANDIDATE_RECORD"
    exit 1
  fi
  RECORDED_TREE="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).candidateTree" "$CANDIDATE_RECORD")"
  RECORDED_COMMIT="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).candidateCommit" "$CANDIDATE_RECORD")"
  RECORDED_MANIFEST="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).manifestBlob || ''" "$CANDIDATE_RECORD")"
  CURRENT_MANIFEST="$(git rev-parse "$RESOLVED_SOURCE_SHA:scripts/public-release-manifest.txt")"
  if [[ "$CANDIDATE_COMMIT" != "$RECORDED_COMMIT" || "$CANDIDATE_TREE" != "$RECORDED_TREE" ]]; then
    fail "Candidate object does not match recorded dry-run hashes"
    exit 1
  fi
  if [[ -z "$RECORDED_MANIFEST" || "$CURRENT_MANIFEST" != "$RECORDED_MANIFEST" ]]; then
    fail "Release manifest changed since dry-run (recorded $RECORDED_MANIFEST, current $CURRENT_MANIFEST)"
    exit 1
  fi
  ok "Candidate matches recorded dry-run object"
fi

validate_commit_graph "$CANDIDATE_COMMIT"
scan_candidate_tree "$CANDIDATE_TREE"
verify_fresh_checkout "$CANDIDATE_COMMIT" "$CANDIDATE_TREE"
run_gitleaks_if_available "$CANDIDATE_COMMIT"
record_candidate "$CANDIDATE_COMMIT" "$CANDIDATE_TREE"

if $DRY_RUN; then
  step "Dry-run complete"
  ok "Candidate commit: $CANDIDATE_COMMIT"
  ok "Candidate tree: $CANDIDATE_TREE"
  ok "No branches, remotes, or working tree were modified"
  CREATED_COMMIT=""
  exit 0
fi

step "Updating $PUBLIC_BRANCH locally"
git branch -f "$PUBLIC_BRANCH" "$CANDIDATE_COMMIT"
CREATED_COMMIT="$CANDIDATE_COMMIT"
ok "Updated $PUBLIC_BRANCH to ${CANDIDATE_COMMIT:0:8}"

step "Pushing $PUBLIC_BRANCH to $REMOTE_NAME/$REMOTE_REF"
git push "$REMOTE_NAME" "$PUBLIC_BRANCH:$REMOTE_REF"
CREATED_COMMIT=""
ok "Pushed successfully"

echo -e "\n${GRN}✅ Published ${RESOLVED_SOURCE_SHA:0:8} → $REMOTE_NAME/$REMOTE_REF (commit ${CANDIDATE_COMMIT:0:8})${OFF}"
