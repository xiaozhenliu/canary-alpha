# Work Activity Fixtures

This directory contains fixture data for the work activity analysis feature.

## Directory Structure

```
tests/fixtures/work-activity/
  synthetic/                    # Synthetic fixtures (committed to repo, CI-safe)
    ide-vscode/                 # IDE category: VS Code with AXWebArea content
    terminal-iterm/             # Terminal category: iTerm2 with AXTextArea
    chrome-doc/                 # Browser category: Chrome reading documentation
    unknown-app/                # Unknown app: triggers generic heuristic fallback
    noise-control-center/       # Noise window: produces Empty_Extraction
  README.md                     # This file
```

## Fixture Categories

### `synthetic/`

Synthetic fixtures are **committed to the repository** and used in CI gate evaluations. They do not contain any real user data — all `accessibility_tree_json` content is hand-crafted and must carry the `"_synthetic": true` marker at the root node (W31 property).

Each fixture category contains:

| File | Purpose |
|---|---|
| `frame.json` | Simulated ScreenPipe frame: `{ id, timestamp, app_name, window_name, accessibility_tree_json }` |
| `ground-truth.json` | Expected extraction output, session boundaries, and find query hit lists |

### Fixture Descriptions

#### `ide-vscode/`

- **App**: `Code` (Visual Studio Code)
- **Window**: TypeScript source file editor
- **AX tree**: Contains `AXWebArea` with TypeScript source code as `value`
- **Expected rule**: `generic` (VS Code is not in `TERMINAL_APP_NAMES`)
- **Extraction anchor**: `AXWebArea` inside the editor group
- **Purpose**: Validates that the generic heuristic correctly identifies `AXWebArea` as the extraction anchor and extracts its `value` text, while filtering out `AXMenuBar` and `AXToolbar` chrome nodes.

#### `terminal-iterm/`

- **App**: `iTerm2`
- **Window**: bash shell session
- **AX tree**: Contains `AXTextArea` with terminal output as `value`
- **Expected rule**: `terminal` (iTerm2 is in `TERMINAL_APP_NAMES`)
- **Extraction anchor**: `AXTextArea` (unique terminal buffer)
- **Purpose**: Validates that `TerminalRefinementRule` takes priority over `GenericHeuristicRule` for iTerm2, and correctly extracts the `AXTextArea` subtree text.

#### `chrome-doc/`

- **App**: `Google Chrome`
- **Window**: MCP documentation page
- **AX tree**: Contains `AXScrollArea > AXWebArea` with page content; also has `AXToolbar` with navigation buttons
- **Expected rule**: `generic`
- **Extraction anchor**: `AXWebArea` inside `AXScrollArea`
- **Purpose**: Validates that `AXToolbar` and `AXButton` chrome nodes are filtered out, and the main `AXWebArea` content is extracted correctly.

#### `unknown-app/`

- **App**: `MyCustomApp` (not in any refinement rule set)
- **Window**: Project dashboard
- **AX tree**: Contains `AXMenuBar`, `AXStatusBar` (chrome), and `AXScrollArea > AXTextArea` (content)
- **Expected rule**: `generic` (fallback)
- **Extraction anchor**: `AXTextArea` inside `AXScrollArea`
- **Purpose**: Validates the generic heuristic fallback for apps not covered by any refinement rule. Also validates that `AXMenuBar`, `AXMenuBarItem`, and `AXStatusBar` nodes are filtered from the chrome blacklist.

#### `noise-control-center/`

- **App**: `Control Center` (macOS system UI panel)
- **Window**: Control Center
- **AX tree**: Contains only `AXButton` nodes (Wi-Fi, Bluetooth, etc.) — no substantive text content
- **Expected rule**: `generic`
- **Expected extraction**: `Empty_Extraction` (`extractedText = ''`)
- **Purpose**: Validates that a window with no `AXTextArea` / `AXWebArea` / `AXScrollArea` subtrees produces an `Empty_Extraction`. The frame still participates in sessionization but does **not** appear in `find` results (keyword or semantic). This verifies the noise-filtering behavior described in R1.6.

## `ground-truth.json` Schema

Each `ground-truth.json` file contains:

```jsonc
{
  "_comment": "Human-readable description of what this fixture tests",
  "frame_id": 1001,                    // Must match frame.json id
  "extractedText": "...",              // Expected ExtractionResult.extractedText
  "extractionRuleKind": "generic",     // "generic" | "terminal"
  "contextLabel": "...",               // Expected ExtractionResult.contextLabel (raw window title)
  "contextKey": "...",                 // Expected ExtractionResult.contextKey (normalized)
  "is_empty_extraction": false,        // Optional: true if extractedText === ''
  "session_count": 1,                  // Expected number of sessions produced
  "session_boundaries": [              // Expected session groupings
    {
      "app_name": "...",
      "context_key": "...",
      "frame_ids": [1001]
    }
  ],
  "find_hit_frame_ids": [1001],        // frame_ids expected to appear in find() results
  "find_queries": ["query1", "query2"] // Sample queries that should hit this fixture
}
```

### Key invariants

- `find_hit_frame_ids` is **empty** for `Empty_Extraction` fixtures (noise-control-center).
- `session_count` counts distinct sessions produced by the Session_Aggregator for this fixture's frames.
- `contextKey` is the normalized form: `appName.toLowerCase() + '::' + normalizeWindowTitle(windowTitle)`.
- `contextLabel` is the **raw** (un-normalized) window title.

## `_synthetic` Marker (W31)

All `accessibility_tree_json` values in synthetic fixtures **must** include `"_synthetic": true` at the root node of the parsed JSON object. This is enforced by the evaluation runner (`run-eval.ts`) which validates the marker before processing any fixture. Missing the marker causes the evaluation to fail with an explicit error.

This requirement (W31 / R12.3) ensures that no real user data can accidentally be committed to the repository as a fixture.

## Adding New Fixture Categories

To add a new fixture category:

1. Create a new subdirectory under `tests/fixtures/work-activity/synthetic/`.
2. Add `frame.json` with a simulated ScreenPipe frame. The `accessibility_tree_json` field must be a JSON string (not an object), and the parsed JSON must have `"_synthetic": true` at the root.
3. Add `ground-truth.json` following the schema above.
4. Update `tests/evaluations/work-activity/run-eval.ts` to include the new fixture in the evaluation set.
5. Update this README with a description of the new category.

## Sanitized Recording Fixtures

**Sanitized recording fixtures are NOT committed to this repository** (R12.3). If you have real ScreenPipe recordings that you want to use for local testing, sanitize them (replace real window titles and extracted text with synthetic equivalents) and store them locally outside the repository. The `.gitignore` at the project root excludes `tests/fixtures/work-activity/sanitized/` for this purpose.
