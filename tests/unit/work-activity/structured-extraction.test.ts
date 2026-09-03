/**
 * Unit tests for Universal Structured AXTree Extractor (`ISSUE-USE-01` to `ISSUE-USE-05`).
 *
 * Validates:
 *   - 4-domain semantic taxonomy: [Window], [Nav], [Action], [Body]
 *   - Session-scoped line-level delta deduplication (USE-R05, 0-byte emission on static frames)
 *   - Navigation context enrichment for context_label and contextKey (USE-R04)
 *   - Visibility pruning (on_screen and onScreen)
 *   - Nested AXWindow title handling in Window domain
 *
 * Tests run 100% in-memory with zero local app installation or login dependencies.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  extractUniversalStructuredElements,
  extractUniversalStructuredText,
  UniversalStructuredExtractor,
  LineDeltaDeduplicator,
  type AccessibilityNode
} from '../../../src/services/work-activity/extraction/universal.js';
import type { ExtractionInput } from '../../../src/services/work-activity/extraction/types.js';

let extractor: UniversalStructuredExtractor;
let deduplicator: LineDeltaDeduplicator;

beforeEach(() => {
  extractor = new UniversalStructuredExtractor();
  deduplicator = new LineDeltaDeduplicator();
});

function makeInput(
  tree: AccessibilityNode | string | null,
  overrides: Partial<ExtractionInput> = {}
): ExtractionInput {
  return {
    frameId: 100,
    frameTimestamp: '2026-09-02T16:00:00.000Z',
    appName: 'TestApp',
    windowTitle: 'Test Window Title',
    accessibilityTreeJson:
      tree === null ? null : typeof tree === 'string' ? tree : JSON.stringify(tree),
    sourceTypes: ['accessibility'],
    ...overrides
  };
}

describe('UniversalStructuredExtractor — USE-R01 to USE-R06', () => {
  describe('1. IM Multi-Pane Chat Topology & Context Label Enrichment (USE-R04)', () => {
    it('preserves top toolbar chat partner and enriches context_label when OS title is coarse', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'WeChat',
        children: [
          {
            role: 'AXToolbar',
            children: [
              {
                role: 'AXStaticText',
                value: '张三 (架构师)'
              },
              {
                role: 'AXStaticText',
                value: 'Topic: 内存泄漏排查与方案评审'
              }
            ]
          },
          {
            role: 'AXGroup',
            children: [
              {
                role: 'AXScrollArea',
                value: '张三: 刚才的 dump 文件分析完了，主要在缓存层。'
              },
              {
                role: 'AXTextArea',
                value: '好的，下午两点准时开会评审。',
                focused: true
              }
            ]
          }
        ]
      };

      const result = extractor.extract(makeInput(tree, { appName: 'WeChat', windowTitle: 'WeChat' }));

      // Enriched contextLabel reflects chat partner
      expect(result.contextLabel).toBe('WeChat - 张三 (架构师)');
      expect(result.contextKey).toBe('WeChat::wechat - 张三 (架构师)');

      // Extracted text contains all 4 domains
      expect(result.extractedText).toContain('[Window] WeChat');
      expect(result.extractedText).toContain('[Nav] 张三 (架构师)');
      expect(result.extractedText).toContain('[Nav] Topic: 内存泄漏排查与方案评审');
      expect(result.extractedText).toContain('[Body] 张三: 刚才的 dump 文件分析完了，主要在缓存层。');
      expect(result.extractedText).toContain('[Body] 好的，下午两点准时开会评审。');
      expect(result.extractedTextHash).not.toBeNull();
      expect(result.extractionRuleKind).toBe('generic');
    });

    it('extracts Slack workspace and channel banner in [Nav] and enriches channel label', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Slack',
        children: [
          {
            role: 'AXBanner',
            children: [
              {
                role: 'AXHeading',
                title: '#incident-20260902'
              }
            ]
          },
          {
            role: 'AXScrollArea',
            value: 'Alice: Deploying hotfix to production now.'
          }
        ]
      };

      const result = extractor.extract(makeInput(tree, { appName: 'Slack', windowTitle: 'Slack' }));
      expect(result.contextLabel).toBe('Slack - #incident-20260902');
      expect(result.extractedText).toContain('[Window] Slack');
      expect(result.extractedText).toContain('[Nav] #incident-20260902');
      expect(result.extractedText).toContain('[Body] Alice: Deploying hotfix to production now.');
    });

    it('prefers a channel navigation candidate over a coarse nested workspace title', () => {
      const tree: AccessibilityNode = {
        role: 'AXApplication',
        children: [{
          role: 'AXWindow',
          title: 'Slack - Acme Corp',
          children: [{ role: 'AXHeading', title: '#incident' }]
        }]
      };

      const result = extractor.extract(makeInput(tree, {
        appName: 'Slack',
        windowTitle: 'Slack'
      }));

      expect(result.contextLabel).toBe('Slack - #incident');
      expect(result.contextKey).toBe('Slack::slack - #incident');
    });
  });

  describe('2. Session-Scoped Line-Level Delta Deduplication (USE-R05)', () => {
    it('emits 0-byte extractedText on repeated identical frames and only new lines when typing', () => {
      const frame1Tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Slack',
        children: [
          {
            role: 'AXToolbar',
            children: [{ role: 'AXStaticText', value: '#general' }]
          },
          {
            role: 'AXTextArea',
            value: 'Hello'
          }
        ]
      };

      // Frame 1: first appearance -> full elements emitted
      const raw1 = extractor.extract(makeInput(frame1Tree, { frameId: 1, appName: 'Slack', windowTitle: 'Slack' }));
      const res1 = deduplicator.process(raw1);
      expect(res1.extractedText).toContain('[Window] Slack');
      expect(res1.extractedText).toContain('[Nav] #general');
      expect(res1.extractedText).toContain('[Body] Hello');
      expect(res1.extractedTextHash).not.toBeNull();

      // Frame 2: identical static frame -> 0 bytes emitted
      const raw2 = extractor.extract(makeInput(frame1Tree, { frameId: 2, appName: 'Slack', windowTitle: 'Slack' }));
      const res2 = deduplicator.process(raw2);
      expect(res2.extractedText).toBe('');
      expect(res2.extractedTextHash).toBeNull();

      // Frame 3: user typed a new line -> ONLY the new line is emitted
      const frame3Tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Slack',
        children: [
          {
            role: 'AXToolbar',
            children: [{ role: 'AXStaticText', value: '#general' }]
          },
          {
            role: 'AXTextArea',
            value: 'Hello\nWorld'
          }
        ]
      };
      const raw3 = extractor.extract(makeInput(frame3Tree, { frameId: 3, appName: 'Slack', windowTitle: 'Slack' }));
      const res3 = deduplicator.process(raw3);
      expect(res3.extractedText).toBe('[Body] World');
      expect(res3.extractedTextHash).not.toBeNull();
    });

    it('preserves duplicate lines that occur within the same frame', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Notes',
        children: [{ role: 'AXTextArea', value: 'same line\nsame line' }]
      };

      const result = deduplicator.process(extractor.extract(makeInput(tree, {
        frameId: 1,
        appName: 'Notes',
        windowTitle: 'Notes'
      })));
      expect(result.extractedText.match(/\[Body\] same line/g)).toHaveLength(2);
    });

    it('preserves multi-context state across interleaving without redundant re-emission (USE-R05)', () => {
      const treeA: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Project A',
        children: [{ role: 'AXTextArea', value: 'git status' }]
      };
      const treeB: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Project B',
        children: [{ role: 'AXTextArea', value: 'cargo build' }]
      };

      // In Project A (Frame 1, t=0s)
      const rawA1 = extractor.extract(makeInput(treeA, { frameId: 1, frameTimestamp: '2026-01-01T00:00:00Z', appName: 'Code', windowTitle: 'Project A' }));
      const resA1 = deduplicator.process(rawA1);
      expect(resA1.extractedText).toContain('[Body] git status');

      // Switch to Project B (Frame 2, t=10s) -> emits Project B content
      const rawB1 = extractor.extract(makeInput(treeB, { frameId: 2, frameTimestamp: '2026-01-01T00:00:10Z', appName: 'Code', windowTitle: 'Project B' }));
      const resB1 = deduplicator.process(rawB1);
      expect(resB1.extractedText).toContain('[Window] Project B');
      expect(resB1.extractedText).toContain('[Body] cargo build');

      // Switch back to Project A (Frame 3, t=20s) -> Project A's history is preserved within session gap!
      const rawA2 = extractor.extract(makeInput(treeA, { frameId: 3, frameTimestamp: '2026-01-01T00:00:20Z', appName: 'Code', windowTitle: 'Project A' }));
      const resA2 = deduplicator.process(rawA2);
      // 'git status' was already seen in Project A's active session -> suppressed to 0 bytes!
      expect(resA2.extractedText).toBe('');
      expect(resA2.extractedTextHash).toBeNull();
    });

    it('resets line hash cache when idle threshold is exceeded for new session (USE-R05)', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Project A',
        children: [{ role: 'AXTextArea', value: 'git status' }]
      };

      // Frame 1 at t=0s
      const raw1 = extractor.extract(makeInput(tree, { frameId: 1, frameTimestamp: '2026-01-01T00:00:00Z', appName: 'Code', windowTitle: 'Project A' }));
      const res1 = deduplicator.process(raw1);
      expect(res1.extractedText).toContain('[Body] git status');

      // Frame 2 at t=600s (> 300s default idle threshold) -> new session, cache resets, full context re-emitted
      const raw2 = extractor.extract(makeInput(tree, { frameId: 2, frameTimestamp: '2026-01-01T00:10:00Z', appName: 'Code', windowTitle: 'Project A' }));
      const res2 = deduplicator.process(raw2);
      expect(res2.extractedText).toContain('[Window] Project A');
      expect(res2.extractedText).toContain('[Body] git status');
    });

    it('resets line hash cache when a historical frame arrives out of order', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Project A',
        children: [{ role: 'AXTextArea', value: 'historical context' }]
      };

      const newer = extractor.extract(makeInput(tree, {
        frameId: 1,
        frameTimestamp: '2026-01-01T00:10:00Z',
        appName: 'Code',
        windowTitle: 'Project A'
      }));
      const older = extractor.extract(makeInput(tree, {
        frameId: 2,
        frameTimestamp: '2026-01-01T00:00:00Z',
        appName: 'Code',
        windowTitle: 'Project A'
      }));

      deduplicator.process(newer);
      const historical = deduplicator.process(older);

      expect(historical.extractedText).toContain('[Body] historical context');
    });

    it('does not retain previewed hashes when a transaction is rolled back', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Project A',
        children: [{ role: 'AXTextArea', value: 'git status' }]
      };
      const raw = extractor.extract(makeInput(tree, {
        frameId: 1,
        appName: 'Code',
        windowTitle: 'Project A'
      }));

      const transaction = deduplicator.beginTransaction();
      const preview = transaction.process(raw);
      expect(preview.extraction.extractedText).toContain('[Body] git status');
      transaction.rollback();

      const retried = deduplicator.process({ ...raw, frameId: 2 });
      expect(retried.extractedText).toContain('[Body] git status');
    });

    it('restores the latest activity timestamp from persisted empty deltas', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Project A',
        children: [{ role: 'AXTextArea', value: 'git status' }]
      };
      const first = extractor.extract(makeInput(tree, {
        frameId: 1,
        frameTimestamp: '2026-01-01T00:00:00.000Z',
        appName: 'Code',
        windowTitle: 'Project A'
      }));
      const emptyDelta = {
        ...first,
        frameId: 2,
        frameTimestamp: '2026-01-01T00:03:20.000Z',
        extractedText: '',
        extractedTextHash: null
      };

      deduplicator.hydrate([first, emptyDelta]);
      const resumed = deduplicator.process({
        ...first,
        frameId: 3,
        frameTimestamp: '2026-01-01T00:06:40.000Z'
      });

      // The empty persisted frame is still activity: its timestamp keeps the
      // session alive, while its lack of text adds no new line hashes.
      expect(resumed.extractedText).toBe('');
      expect(resumed.extractedTextHash).toBeNull();
    });

    it('commits empty-frame activity timestamps with the transaction', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Project A',
        children: [{ role: 'AXTextArea', value: 'git status' }]
      };
      const first = extractor.extract(makeInput(tree, {
        frameId: 1,
        frameTimestamp: '2026-01-01T00:00:00.000Z',
        appName: 'Code',
        windowTitle: 'Project A'
      }));
      const empty = {
        ...first,
        frameId: 2,
        frameTimestamp: '2026-01-01T00:03:20.000Z',
        extractedText: '',
        extractedTextHash: null
      };
      const transaction = deduplicator.beginTransaction();
      transaction.process(first);
      transaction.process(empty);
      transaction.commit();

      const resumed = deduplicator.process({
        ...first,
        frameId: 3,
        frameTimestamp: '2026-01-01T00:06:40.000Z'
      });
      expect(resumed.extractedText).toBe('');
      expect(resumed.extractedTextHash).toBeNull();
    });

    it('evicts inactive contexts while processing a later context', () => {
      const shortLivedDeduplicator = new LineDeltaDeduplicator({ idleThresholdMs: 1_000 });
      const treeA: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Project A',
        children: [{ role: 'AXTextArea', value: 'git status' }]
      };
      const treeB: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Project B',
        children: [{ role: 'AXTextArea', value: 'cargo build' }]
      };
      const treeC: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Project C',
        children: [{ role: 'AXTextArea', value: 'npm test' }]
      };

      shortLivedDeduplicator.process(extractor.extract(makeInput(treeA, {
        frameId: 1,
        frameTimestamp: '2026-01-01T00:00:00.000Z',
        appName: 'Code',
        windowTitle: 'Project A'
      })));
      shortLivedDeduplicator.process(extractor.extract(makeInput(treeB, {
        frameId: 2,
        frameTimestamp: '2026-01-01T00:00:00.500Z',
        appName: 'Code',
        windowTitle: 'Project B'
      })));
      shortLivedDeduplicator.process(extractor.extract(makeInput(treeC, {
        frameId: 3,
        frameTimestamp: '2026-01-01T00:00:02.000Z',
        appName: 'Code',
        windowTitle: 'Project C'
      })));

      const revisitedB = shortLivedDeduplicator.process(extractor.extract(makeInput(treeB, {
        frameId: 4,
        frameTimestamp: '2026-01-01T00:00:02.100Z',
        appName: 'Code',
        windowTitle: 'Project B'
      })));
      expect(revisitedB.extractedText).toContain('[Body] cargo build');
    });
  });

  describe('3. Navigation context candidate selection', () => {
    it('ignores toolbar utility labels when enriching a coarse window title', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Slack',
        children: [
          {
            role: 'AXToolbar',
            children: [
              { role: 'AXStaticText', value: 'Back' },
              { role: 'AXStaticText', value: 'Search' },
              { role: 'AXStaticText', value: '#incident-20260902' }
            ]
          },
          { role: 'AXScrollArea', value: 'Database latency investigation' }
        ]
      };

      const result = extractor.extract(makeInput(tree, {
        appName: 'Slack',
        windowTitle: 'Slack'
      }));
      expect(result.contextLabel).toBe('Slack - #incident-20260902');
      expect(result.contextKey).toBe('Slack::slack - #incident-20260902');
    });

    it('treats window-direct static text as navigation context', () => {
      const tree: AccessibilityNode = {
        role: 'AXApplication',
        children: [{
          role: 'AXWindow',
          title: 'Slack',
          children: [
            { role: 'AXStaticText', value: 'Alice' },
            { role: 'AXScrollArea', value: 'Deploying the hotfix.' }
          ]
        }]
      };

      const result = extractor.extract(makeInput(tree, {
        appName: 'Slack',
        windowTitle: 'Slack'
      }));

      expect(result.extractedText).toContain('[Nav] Alice');
      expect(result.extractedText).toContain('[Body] Deploying the hotfix.');
      expect(result.contextLabel).toBe('Slack - Alice');
    });

    it('keeps toolbar and dialog container domains over body child roles', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'App',
        children: [
          {
            role: 'AXToolbar',
            children: [{ role: 'AXTextField', value: 'https://example.test' }]
          },
          {
            role: 'AXDialog',
            children: [{ role: 'AXTextArea', value: 'Confirm export' }]
          }
        ]
      };

      const elements = extractUniversalStructuredElements(tree);
      expect(elements.navLines).toContain('[Nav] https://example.test');
      expect(elements.bodyLines).not.toContain('[Body] https://example.test');
      expect(elements.actionLines).toContain('[Action] Confirm export');
      expect(elements.bodyLines).not.toContain('[Body] Confirm export');
    });
  });

  describe('4. IDE Breadcrumbs and Active Tabs', () => {
    it('extracts active tab and breadcrumb path into [Nav]', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'computer-history-mcp — VS Code',
        children: [
          {
            role: 'AXTabGroup',
            children: [
              {
                role: 'AXRadioButton',
                title: 'find-service.ts'
              }
            ]
          },
          {
            role: 'AXToolbar',
            children: [
              {
                role: 'AXStaticText',
                value: 'computer-history-mcp > src > services > find-service.ts'
              }
            ]
          },
          {
            role: 'AXTextArea',
            value: 'export class DefaultFindService implements FindService {',
            focused: true
          }
        ]
      };

      const elements = extractUniversalStructuredElements(tree, 'computer-history-mcp — VS Code');
      expect(elements.windowLines).toEqual(['[Window] computer-history-mcp — VS Code']);
      expect(elements.navLines).toContain('[Nav] find-service.ts');
      expect(elements.navLines).toContain('[Nav] computer-history-mcp > src > services > find-service.ts');
      expect(elements.bodyLines).toContain('[Body] export class DefaultFindService implements FindService {');
    });
  });

  describe('5. Action Menus and Modal Confirmation Dialogs', () => {
    it('extracts visible menu items with [Action] tag', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'App',
        children: [
          {
            role: 'AXMenuBar',
            children: [
              {
                role: 'AXMenu',
                title: 'File',
                children: [
                  { role: 'AXMenuItem', title: 'Export As...' },
                  { role: 'AXMenuItem', title: 'Save As PDF' }
                ]
              }
            ]
          }
        ]
      };

      const text = extractUniversalStructuredText(tree, 'App');
      expect(text).toContain('[Action] File');
      expect(text).toContain('[Action] Export As...');
      expect(text).toContain('[Action] Save As PDF');
    });

    it('extracts macOS SecurityAgent permission modal text with [Action]', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'SecurityAgent',
        children: [
          {
            role: 'AXSheet',
            children: [
              {
                role: 'AXStaticText',
                value: 'Terminal wants to access Accessibility features on this Mac.'
              },
              {
                role: 'AXButton',
                title: 'Allow'
              }
            ]
          }
        ]
      };

      const text = extractUniversalStructuredText(tree, 'SecurityAgent');
      expect(text).toContain('[Window] SecurityAgent');
      expect(text).toContain('[Action] Terminal wants to access Accessibility features on this Mac.');
      expect(text).toContain('[Action] Allow');
    });
  });

  describe('6. Nested AXWindow Titles and Graceful GPUI Fallback', () => {
    it('classifies the semantic root node and its own text', () => {
      const bodyRoot: AccessibilityNode = {
        role: 'AXWebArea',
        value: 'Root body text',
        children: [{ role: 'AXStaticText', value: 'Nested body text' }]
      };
      const dialogRoot: AccessibilityNode = {
        role: 'AXDialog',
        title: 'Confirm export',
        children: [{ role: 'AXStaticText', value: 'Export this file?' }]
      };

      const bodyText = extractUniversalStructuredText(bodyRoot);
      const dialogText = extractUniversalStructuredText(dialogRoot);
      expect(bodyText).toContain('[Body] Root body text');
      expect(bodyText).toContain('[Body] Nested body text');
      expect(dialogText).toContain('[Action] Confirm export');
      expect(dialogText).toContain('[Action] Export this file?');
    });

    it('normalizes Screenpipe flat AX arrays before structured extraction', () => {
      const flatTree = [
        { role: 'AXApplication', text: 'Slack', depth: 0 },
        { role: 'AXWindow', text: 'Slack', depth: 1 },
        { role: 'AXToolbar', depth: 2 },
        { role: 'AXStaticText', text: 'Alice', depth: 3 },
        { role: 'AXMenu', depth: 2 },
        { role: 'AXMenuItem', text: 'Export', depth: 3 },
        { role: 'AXScrollArea', depth: 2 },
        { role: 'AXWebArea', value: 'Message body', depth: 3 }
      ];

      const result = extractor.extract(makeInput(JSON.stringify(flatTree), {
        appName: 'Slack',
        windowTitle: 'Slack'
      }));

      expect(result.extractedText).toContain('[Window] Slack');
      expect(result.extractedText).toContain('[Nav] Alice');
      expect(result.extractedText).toContain('[Action] Export');
      expect(result.extractedText).toContain('[Body] Message body');
      expect(result.contextLabel).toBe('Slack - Alice');
    });

    it('classifies nested AXWindow titles under [Window] domain', () => {
      const tree: AccessibilityNode = {
        role: 'AXApplication',
        title: 'ChromeApp',
        children: [
          {
            role: 'AXWindow',
            title: 'Google Chrome - PR #42',
            children: [
              { role: 'AXStaticText', value: 'Pull Request Body' }
            ]
          }
        ]
      };

      const elements = extractUniversalStructuredElements(tree);
      expect(elements.windowLines).toContain('[Window] Google Chrome - PR #42');
      expect(elements.navLines).toContain('[Nav] Pull Request Body');
    });

    it('classifies AXDocument title under [Window] domain (USE-R01)', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Browser',
        children: [
          {
            role: 'AXDocument',
            title: 'Computer History MCP Documentation',
            children: [
              { role: 'AXStaticText', value: 'Page Content' }
            ]
          }
        ]
      };

      const elements = extractUniversalStructuredElements(tree);
      expect(elements.windowLines).toContain('[Window] Computer History MCP Documentation');
      expect(elements.navLines).toContain('[Nav] Page Content');
    });

    it('gracefully extracts top-level window title and body for shallow trees (Zed fallback)', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Zed — computer-history-mcp'
      };

      const result = extractor.extract(makeInput(tree, { appName: 'Zed', windowTitle: 'Zed — computer-history-mcp' }));
      expect(result.extractedText).toBe('[Window] Zed — computer-history-mcp');
      expect(result.extractedTextHash).not.toBeNull();
    });
  });

  describe('7. Smart Visibility Pruning (on_screen and onScreen)', () => {
    it('ignores nodes with snake_case on_screen: false', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'App',
        children: [
          {
            role: 'AXStaticText',
            value: 'Visible text'
          },
          {
            role: 'AXStaticText',
            value: 'Hidden off-screen text',
            on_screen: false
          }
        ]
      };

      const text = extractUniversalStructuredText(tree);
      expect(text).toContain('Visible text');
      expect(text).not.toContain('Hidden off-screen text');
    });

    it('ignores nodes with camelCase onScreen: false', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'App',
        children: [
          {
            role: 'AXStaticText',
            value: 'Visible text'
          },
          {
            role: 'AXStaticText',
            value: 'Hidden off-screen text',
            onScreen: false
          }
        ]
      };

      const text = extractUniversalStructuredText(tree);
      expect(text).toContain('Visible text');
      expect(text).not.toContain('Hidden off-screen text');
    });

    it('drops an invisible root window and its entire subtree', () => {
      const tree: AccessibilityNode = {
        role: 'AXWindow',
        title: 'Hidden Window',
        on_screen: false,
        children: [
          { role: 'AXTextArea', value: 'should not be indexed' }
        ]
      };

      expect(extractUniversalStructuredText(tree)).toBe('');
    });
  });
});
