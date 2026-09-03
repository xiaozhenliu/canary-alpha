export type EvaluationTransportProfile = 'http-local';
export type EvaluationTopology = 'single-user-local';
export type EvaluationFixtureMode = 'controlled-real';

export interface V1EvaluationTask {
  id: string;
  goal: string;
  transportProfile: EvaluationTransportProfile;
  topology: EvaluationTopology;
  fixtureDependencyMode: EvaluationFixtureMode;
  maxTurns: number;
  evidenceFile: string;
  query: string;
  requiredTranscriptTokens: string[];
  requiredToolMarkers: string[];
}

export const V1_EVALUATION_TASKS: V1EvaluationTask[] = [
  {
    id: 'status-and-recent-activity',
    goal: 'Confirm the local HTTP MCP server is healthy, then retrieve bounded recent activity over the same agent session.',
    transportProfile: 'http-local',
    topology: 'single-user-local',
    fixtureDependencyMode: 'controlled-real',
    maxTurns: 4,
    evidenceFile: 'status-and-recent-activity.txt',
    query: [
      'Use only the configured MCP server.',
      'First call internal-status.',
      'Then call recall with from "2026-04-13T11:50:00.000Z" to "2026-04-13T12:00:00.000Z" granularity session and includeSummary false.',
      'Report the server mode and every returned session id and evidence frame id.',
      'End your final answer with exactly: EVAL status-and-recent-activity PASS'
    ].join(' '),
    requiredTranscriptTokens: ['EVAL status-and-recent-activity PASS', 'http', '9101'],
    requiredToolMarkers: [
      'preparing mcp_computer_history_mcp_v1_evals_internal_status',
      'preparing mcp_computer_history_mcp_v1_evals_recall'
    ]
  },
  {
    id: 'retrieval-summary',
    goal: 'Find a known retrieval fixture and summarize the returned evidence in a bounded agent flow.',
    transportProfile: 'http-local',
    topology: 'single-user-local',
    fixtureDependencyMode: 'controlled-real',
    maxTurns: 4,
    evidenceFile: 'retrieval-summary.txt',
    query: [
      'Use only the configured MCP server.',
      'Call find with query "budget planning evaluation" in hybrid mode.',
      'Report the best matching frameId, then summarize the evidence in one sentence.',
      'End your final answer with exactly: EVAL retrieval-summary PASS'
    ].join(' '),
    requiredTranscriptTokens: ['EVAL retrieval-summary PASS', '9102', 'budget planning evaluation note'],
    requiredToolMarkers: ['preparing mcp_computer_history_mcp_v1_evals_find']
  },
  {
    id: 'find-then-refine',
    goal: 'Use a broad retrieval query, then refine the result set with a second tool call pattern before answering.',
    transportProfile: 'http-local',
    topology: 'single-user-local',
    fixtureDependencyMode: 'controlled-real',
    maxTurns: 5,
    evidenceFile: 'find-then-refine.txt',
    query: [
      'Use only the configured MCP server.',
      'First call find with query "action item evaluation" in hybrid mode.',
      'Then refine the answer by calling recall with from "2026-04-13T11:00:00.000Z" to "2026-04-13T12:00:00.000Z" granularity session and includeSummary false.',
      'Identify the evidence frame id that still matches the action-item request after refinement.',
      'End your final answer with exactly: EVAL find-then-refine PASS'
    ].join(' '),
    requiredTranscriptTokens: ['EVAL find-then-refine PASS', '9103'],
    requiredToolMarkers: [
      'preparing mcp_computer_history_mcp_v1_evals_find',
      'preparing mcp_computer_history_mcp_v1_evals_recall'
    ]
  },
  {
    id: 'memory-roundtrip',
    goal: 'Write bounded memory content and then read it back from the persisted memory scope.',
    transportProfile: 'http-local',
    topology: 'single-user-local',
    fixtureDependencyMode: 'controlled-real',
    maxTurns: 4,
    evidenceFile: 'memory-roundtrip.txt',
    query: [
      'Use only the configured MCP server.',
      'Call memory-write with scope memory, mode append, and content "remember-eval-token".',
      'Then call memory-read with scope memory.',
      'Report the exact combined memory content after the write, including the preloaded line and the appended token.',
      'End your final answer with exactly: EVAL memory-roundtrip PASS'
    ].join(' '),
    requiredTranscriptTokens: [
      'EVAL memory-roundtrip PASS',
      'seed-memory-prefix',
      'remember-eval-token'
    ],
    requiredToolMarkers: [
      'preparing mcp_computer_history_mcp_v1_evals_memory_write',
      'preparing mcp_computer_history_mcp_v1_evals_memory_read'
    ]
  },
  {
    id: 'failure-recovery',
    goal: 'Handle a controlled degraded retrieval path without dead-ending the task.',
    transportProfile: 'http-local',
    topology: 'single-user-local',
    fixtureDependencyMode: 'controlled-real',
    maxTurns: 5,
    evidenceFile: 'failure-recovery.txt',
    query: [
      'Use only the configured MCP server.',
      'Call find with query "fallback failure evaluation" in hybrid mode.',
      'If the retrieval degrades, continue and report the returned frameId plus the matchSource or fallback mode.',
      'End your final answer with exactly: EVAL failure-recovery PASS'
    ].join(' '),
    requiredTranscriptTokens: ['EVAL failure-recovery PASS', 'keyword', '9104'],
    requiredToolMarkers: ['preparing mcp_computer_history_mcp_v1_evals_find']
  }
];
