#!/usr/bin/env bash
# prepare-public-history-rewrite.sh
# Record current public refs and build a clean-root public candidate locally.
# Does not push or rewrite remotes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PUBLIC_BRANCH="public-main"
REMOTE_NAME="public"
REMOTE_REF="main"
RECORD_DIR="$REPO_ROOT/.codex-review/public-history-rewrite"
TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"

mkdir -p "$RECORD_DIR"

step() { echo "==> $*"; }

step "Recording current public refs"
if ! git fetch "$REMOTE_NAME" "$REMOTE_REF" --quiet; then
  echo "Failed to fetch $REMOTE_NAME/$REMOTE_REF; cannot record a trustworthy remote lease." >&2
  exit 1
fi

REMOTE_PUBLIC_SHA="$(git rev-parse "$REMOTE_NAME/$REMOTE_REF")"

{
  echo "# Public history rewrite snapshot"
  echo
  echo "- recordedAt: $TIMESTAMP"
  echo "- localPublicMain: $(git rev-parse "$PUBLIC_BRANCH")"
  echo "- remotePublicMain: $REMOTE_PUBLIC_SHA"
  echo
  echo "## Method"
  echo
  echo "Preferred cleanup: replace remote main with a clean-root filtered candidate"
  echo "generated from a committed reviewed dev SHA. Force-push must use --force-with-lease"
  echo "against the recorded remote SHA. Local recovery branch is not pushed."
  echo
  echo "## Remaining risk"
  echo
  echo "Forks, clones, mirrors, and caches can retain old history after rewrite."
  echo "Non-credential historical exposure outside repository control does not block rename."
  echo
  echo "## Remote tags and heads"
  if ! git ls-remote "$REMOTE_NAME"; then
    echo "Failed to enumerate remote refs for $REMOTE_NAME" >&2
    exit 1
  fi
} > "$RECORD_DIR/snapshot-$TIMESTAMP.md"

git branch -f "public-history-backup/$TIMESTAMP" "$REMOTE_PUBLIC_SHA"
step "Created local recovery branch public-history-backup/$TIMESTAMP at $REMOTE_PUBLIC_SHA"

{
  echo
  echo "## Controlled refs note"
  echo
  echo "This repository currently publishes only public/main. Other remote heads/tags are"
  echo "recorded above for operator review before force-with-lease. Tags still pointing at"
  echo "old history must be deleted or retargeted by a human before cleanup is complete."
} >> "$RECORD_DIR/snapshot-$TIMESTAMP.md"

step "Building clean-root public candidate"
set +e
OUTPUT="$(
  cd "$REPO_ROOT" && bash "$SCRIPT_DIR/publish-to-public.sh" --dry-run --root 2>&1
)"
STATUS=$?
set -e
echo "$OUTPUT"

if [[ $STATUS -ne 0 ]]; then
  echo "$OUTPUT" > "$RECORD_DIR/failure-$TIMESTAMP.log"
  exit "$STATUS"
fi

CANDIDATE_RECORD="$REPO_ROOT/.codex-review/public-release-candidate.json"

if [[ ! -f "$CANDIDATE_RECORD" ]]; then
  echo "Missing candidate record at $CANDIDATE_RECORD" >&2
  exit 1
fi

CANDIDATE_COMMIT="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).candidateCommit" "$CANDIDATE_RECORD")"
CANDIDATE_TREE="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).candidateTree" "$CANDIDATE_RECORD")"

if [[ -z "$CANDIDATE_COMMIT" || -z "$CANDIDATE_TREE" ]]; then
  echo "Failed to read candidate hashes from $CANDIDATE_RECORD" >&2
  exit 1
fi

cat > "$RECORD_DIR/candidate-$TIMESTAMP.json" <<EOF
{
  "recordedAt": "$TIMESTAMP",
  "recoveryBranch": "public-history-backup/$TIMESTAMP",
  "candidateCommit": "$CANDIDATE_COMMIT",
  "candidateTree": "$CANDIDATE_TREE",
  "remoteLeaseRef": "$REMOTE_NAME/$REMOTE_REF",
  "remoteLeaseSha": "$REMOTE_PUBLIC_SHA",
  "method": "clean-root-filtered-snapshot",
  "gitleaksAllowlist": "scripts/public-release-gitleaks-allowlist.txt"
}
EOF

{
  echo
  echo "## Candidate"
  echo
  echo "- candidateCommit: \`$CANDIDATE_COMMIT\`"
  echo "- candidateTree: \`$CANDIDATE_TREE\`"
  echo "- recoveryBranch: \`public-history-backup/$TIMESTAMP\`"
} >> "$RECORD_DIR/snapshot-$TIMESTAMP.md"

step "Clean-root candidate ready"
echo "candidateCommit=$CANDIDATE_COMMIT"
echo "candidateTree=$CANDIDATE_TREE"
echo "snapshot=$RECORD_DIR/snapshot-$TIMESTAMP.md"
echo "record=$RECORD_DIR/candidate-$TIMESTAMP.json"
