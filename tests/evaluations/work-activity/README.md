# Work Activity Analysis — CI Gate Evaluation

This directory contains the CI gate evaluation scripts for the `work-activity-analysis` feature.

## Scripts

| Script | Purpose | CI Gate |
|---|---|---|
| `run-eval.ts` | Validates extraction, session, and retrieval quality against synthetic fixtures | ✅ Yes |
| `run-faithfulness.ts` | Evaluates `remote-llm` SummaryProvider faithfulness using a judge LLM | ❌ No (manual) |

## Running the Evaluation

```bash
# CI gate evaluation (exits 0 on pass, 1 on fail)
npm run eval:work-activity

# Faithfulness evaluation (requires EVAL_JUDGE_* env vars; skips if absent)
npm run eval:faithfulness
```

## CI Gate Metrics (`run-eval.ts`)

The evaluation runs against the synthetic fixtures in `tests/fixtures/work-activity/synthetic/` and computes four metrics:

| Metric | Threshold | Description |
|---|---|---|
| `extractionPrecision` | ≥ 0.85 | Fraction of extracted texts that match ground truth (generic + terminal rules) |
| `extractionRecall` | ≥ 0.80 | Fraction of ground-truth texts that were correctly extracted |
| `sessionBoundaryIoU` | ≥ 0.75 | Intersection-over-Union of expected vs. actual session boundaries |
| `findRecall` | ≥ 0.80 | Fraction of `find()` queries that returned all expected frame IDs |
| `recallSessionCountDelta` | ≤ 0.20 | Relative deviation of `recall()` session count from expected count |

### Output Format

The script outputs a JSON object to stdout:

```json
{
  "extraction": {
    "generic": { "precision": 1.0, "recall": 1.0 },
    "terminal": { "precision": 1.0, "recall": 1.0 }
  },
  "sessionBoundaryIoU": 1.0,
  "findRecall": 1.0,
  "recallSessionCountDelta": 0.0,
  "pass": true,
  "threshold": {
    "extractionPrecision": 0.85,
    "extractionRecall": 0.80,
    "sessionBoundaryIoU": 0.75,
    "findRecall": 0.80,
    "recallSessionCountDelta": 0.20
  },
  "details": {
    "fixturesLoaded": 5,
    "sessionIoU": { "intersection": 5, "union": 5 },
    "findHits": { "hits": 12, "total": 12 },
    "recallSessions": { "actual": 5, "expected": 5 }
  }
}
```

### How It Works

1. **Load fixtures** — reads all `frame.json` + `ground-truth.json` pairs from `tests/fixtures/work-activity/synthetic/`
2. **Validate `_synthetic` marker** — every `accessibility_tree_json` must have `"_synthetic": true` at the root (W31 / R12.3); missing marker causes the eval to fail with an explicit error
3. **Set up in-memory infrastructure** — creates an in-memory SQLite derived database, `InMemoryVectorStore`, and a stub embedding provider (returns a fixed vector; CI has no real embedding service)
4. **Feed fixtures** — loads all fixture frames into a `FixtureScreenpipeClient` stub
5. **Run `IndexingService.runOnce()`** — processes all frames through the full extraction → session aggregation → embedding pipeline
6. **Compute metrics** — reads back `extracted_content` and `sessions` tables, runs `find()` and `recall()` queries, compares against ground truth
7. **Output + exit** — prints JSON to stdout; exits 0 on pass, 1 on fail

## Faithfulness Evaluation (`run-faithfulness.ts`)

The faithfulness evaluation is **not** part of the CI gate. It requires a live LLM endpoint and is intended for periodic manual runs by developers.

### Configuration

Set the following environment variables before running:

```bash
export EVAL_JUDGE_BASE_URL="https://api.deepseek.com"
export EVAL_JUDGE_API_KEY="sk-..."
export EVAL_JUDGE_MODEL="deepseek-chat"
```

If any of these variables is missing, the script exits 0 (skip) without error.

The judge endpoint should be **different** from the `llm.base_url` used by the `remote-llm` SummaryProvider to avoid self-check bias (R12.4 / R12.5).

### Output

The script writes `tests/evaluations/work-activity/last-faithfulness-report.json` with per-session faithfulness scores. This file is `.gitignore`d and not committed to the repository.

## Fixture Requirements

All fixtures in `tests/fixtures/work-activity/synthetic/` must:

1. Have a `frame.json` with a valid `accessibility_tree_json` containing `"_synthetic": true` at the root
2. Have a `ground-truth.json` following the schema in `tests/fixtures/work-activity/README.md`
3. Not contain any real user data (R12.3)

See `tests/fixtures/work-activity/README.md` for the full fixture schema and instructions for adding new categories.
