#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINEAR_API_URL = 'https://api.linear.app/graphql';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const envFilePath = resolve(repositoryRoot, '.env');
const supportedStatuses = ['Todo', 'In Progress', 'Done'] as const;
const managedLabels = ['feature', 'bug', 'safety'] as const;

type SupportedStatus = (typeof supportedStatuses)[number];
type ManagedLabel = (typeof managedLabels)[number];

type EnvConfig = {
  apiKey: string;
  projectUrl: string;
};

type ProjectReference = {
  projectSlug: string;
  workspaceSlug: string;
};

type CliCommand =
  | {
      kind: 'list';
    }
  | {
      kind: 'create';
      title: string;
      description?: string;
      labels: ManagedLabel[];
    }
  | {
      kind: 'update-status';
      issue: string;
      status: SupportedStatus;
    }
  | {
      kind: 'update-description';
      issue: string;
      description: string;
    }
  | {
      kind: 'assign';
      issue: string;
      assignee: string;
    }
  | {
      kind: 'comment';
      issue: string;
      body: string;
    }
  | {
      kind: 'update-labels';
      issue: string;
      labels: ManagedLabel[];
    }
  | {
      kind: 'delete';
      issue: string;
    };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export async function readLinearEnv(filePath = envFilePath): Promise<EnvConfig> {
  if (!existsSync(filePath)) {
    throw new Error(`Missing env file at ${filePath}.`);
  }

  const contents = await readFile(filePath, 'utf8');
  const values = parseSimpleEnv(contents);
  const apiKey = values.LINEAR_API_KEY?.trim();
  const projectUrl = values.LINEAR_PROJECT_URL?.trim();

  if (!apiKey) {
    throw new Error('LINEAR_API_KEY is missing from .env.');
  }

  if (!projectUrl) {
    throw new Error('LINEAR_PROJECT_URL is missing from .env.');
  }

  return {
    apiKey,
    projectUrl
  };
}

export function parseSimpleEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

export function parseLinearProjectUrl(projectUrl: string): ProjectReference {
  let url: URL;

  try {
    url = new URL(projectUrl);
  } catch {
    throw new Error(`LINEAR_PROJECT_URL is not a valid URL: ${projectUrl}`);
  }

  if (url.hostname !== 'linear.app') {
    throw new Error(`LINEAR_PROJECT_URL must point at linear.app: ${projectUrl}`);
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const projectIndex = segments.indexOf('project');
  if (projectIndex !== 1 || segments[0] === undefined || segments[2] === undefined) {
    throw new Error(`LINEAR_PROJECT_URL must look like https://linear.app/<workspace>/project/<slug>/...: ${projectUrl}`);
  }

  return {
    workspaceSlug: segments[0],
    projectSlug: segments[2]
  };
}

export function parseCliArgs(argv: string[]): CliCommand {
  const [command, ...rest] = argv;

  switch (command) {
    case 'list':
      return { kind: 'list' };
    case 'create': {
      const title = readFlagValue(rest, '--title');
      if (!title) {
        throw new Error('Missing required --title for create.');
      }

      return {
        kind: 'create',
        title,
        description: readFlagValue(rest, '--description'),
        labels: readManagedLabels(rest, 'create')
      };
    }
    case 'update-status': {
      const issue = readFlagValue(rest, '--issue');
      const status = readFlagValue(rest, '--status');
      if (!issue) {
        throw new Error('Missing required --issue for update-status.');
      }
      if (!status) {
        throw new Error('Missing required --status for update-status.');
      }
      if (!isSupportedStatus(status)) {
        throw new Error(`Unsupported status \"${status}\". Supported values: ${supportedStatuses.join(', ')}.`);
      }

      return {
        kind: 'update-status',
        issue,
        status
      };
    }
    case 'update-description': {
      const issue = readFlagValue(rest, '--issue');
      const description = readFlagValue(rest, '--description');
      if (!issue) {
        throw new Error('Missing required --issue for update-description.');
      }
      if (!description) {
        throw new Error('Missing required --description for update-description.');
      }

      return {
        kind: 'update-description',
        issue,
        description
      };
    }
    case 'assign': {
      const issue = readFlagValue(rest, '--issue');
      const assignee = readFlagValue(rest, '--assignee');
      if (!issue) {
        throw new Error('Missing required --issue for assign.');
      }
      if (!assignee) {
        throw new Error('Missing required --assignee for assign.');
      }

      return {
        kind: 'assign',
        issue,
        assignee
      };
    }
    case 'comment': {
      const issue = readFlagValue(rest, '--issue');
      const body = readFlagValue(rest, '--body');
      if (!issue) {
        throw new Error('Missing required --issue for comment.');
      }
      if (!body) {
        throw new Error('Missing required --body for comment.');
      }

      return {
        kind: 'comment',
        issue,
        body
      };
    }
    case 'update-labels': {
      const issue = readFlagValue(rest, '--issue');
      if (!issue) {
        throw new Error('Missing required --issue for update-labels.');
      }

      return {
        kind: 'update-labels',
        issue,
        labels: readManagedLabels(rest, 'update-labels', { requireAtLeastOne: true })
      };
    }
    case 'delete': {
      const issue = readFlagValue(rest, '--issue');
      if (!issue) {
        throw new Error('Missing required --issue for delete.');
      }

      return {
        kind: 'delete',
        issue
      };
    }
    default:
      throw new Error('Usage: npm run linear -- <list|create|update-status|update-description|assign|comment|update-labels|delete> [options]');
  }
}

function isSupportedStatus(value: string): value is SupportedStatus {
  return supportedStatuses.includes(value as SupportedStatus);
}

function readFlagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
}

function isManagedLabel(value: string): value is ManagedLabel {
  return managedLabels.includes(value as ManagedLabel);
}

function readFlagValues(argv: string[], flag: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag) {
      const value = argv[index + 1];
      if (value !== undefined) {
        values.push(value);
      }
    }
  }

  return values;
}

function normalizeManagedLabels(values: string[]): ManagedLabel[] {
  const normalized = new Set<ManagedLabel>();

  for (const value of values) {
    const candidate = value.trim().toLowerCase();
    if (!isManagedLabel(candidate)) {
      throw new Error(`Unsupported label "${value}". Supported values: ${managedLabels.join(', ')}.`);
    }
    normalized.add(candidate);
  }

  return [...normalized];
}

function readManagedLabels(argv: string[], command: 'create' | 'update-labels', options?: { requireAtLeastOne?: boolean }): ManagedLabel[] {
  const labels = normalizeManagedLabels(readFlagValues(argv, '--label'));
  if (options?.requireAtLeastOne && labels.length === 0) {
    throw new Error(`Missing required --label for ${command}.`);
  }

  return labels;
}


async function linearGraphQL<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`Linear API returned HTTP ${response.status}.`);
  }

  const body = await response.json() as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };

  if (body.errors && body.errors.length > 0) {
    throw new Error(body.errors.map((error) => error.message ?? 'Unknown Linear API error.').join('; '));
  }

  if (!body.data) {
    throw new Error('Linear API returned no data.');
  }

  return body.data;
}

type ProjectLookupResult = {
  projects: {
    nodes: Array<{
      id: string;
      name: string;
      slugId: string;
      url: string;
      teams: {
        nodes: Array<{
          id: string;
          key: string;
          name: string;
        }>;
      };
    }>;
  };
};

type ProjectTeamStatesResult = {
  team: {
    id: string;
    states: {
      nodes: Array<{
        id: string;
        name: string;
        type: string;
      }>;
    };
  } | null;
};

type ProjectIssueListResult = {
  project: {
    id: string;
    name: string;
    url: string;
    issues: {
      nodes: Array<{
        id: string;
        identifier: string;
        title: string;
        state: {
          name: string;
        };
        assignee: {
          name: string;
        } | null;
        labels: {
          nodes: Array<{
            id: string;
            name: string;
          }>;
        };
        project: {
          id: string;
        } | null;
        team: {
          id: string;
          states: {
            nodes: Array<{
              id: string;
              name: string;
              type: string;
            }>;
          };
        };
      }>;
    };
  } | null;
};

type IssueCreateResult = {
  issueCreate: {
    success: boolean;
    issue: {
      id: string;
      identifier: string;
      title: string;
      url: string;
    } | null;
  };
};

type IssueUpdateResult = {
  issueUpdate: {
    success: boolean;
    issue: {
      id: string;
      identifier: string;
      title: string;
      state: {
        name: string;
      };
      url: string;
    } | null;
  };
};

type ViewerResult = {
  viewer: {
    id: string;
    name: string;
    email?: string | null;
  };
};

type IssueDeleteResult = {
  issueDelete: {
    success: boolean;
  };
};

type ProjectLabelsResult = {
  team: {
    id: string;
    labels: {
      nodes: Array<{
        id: string;
        name: string;
      }>;
    };
  } | null;
};

type CommentCreateResult = {
  commentCreate: {
    success: boolean;
    comment: {
      id: string;
      body: string;
      url: string | null;
      issue: {
        identifier: string;
        title: string;
      } | null;
    } | null;
  };
};

async function resolveProject(apiKey: string, reference: ProjectReference) {
  const data = await linearGraphQL<ProjectLookupResult>(
    apiKey,
    `query ProjectLookup {
      projects(first: 50) {
        nodes {
          id
          name
          slugId
          url
          teams {
            nodes {
              id
              key
              name
            }
          }
        }
      }
    }`,
    {}
  );

  const project = data.projects.nodes.find((item) => item.url.includes(`/${reference.workspaceSlug}/project/`) && item.url.endsWith(`/${reference.projectSlug}`));
  if (!project) {
    throw new Error(`Could not find Linear project slug \"${reference.projectSlug}\" in workspace \"${reference.workspaceSlug}\".`);
  }

  const team = project.teams.nodes[0];
  if (!team) {
    throw new Error(`Linear project \"${project.name}\" has no team attached.`);
  }

  return {
    project,
    team
  };
}

async function listProjectIssues(apiKey: string, projectId: string) {
  const data = await linearGraphQL<ProjectIssueListResult>(
    apiKey,
    `query ProjectIssues($projectId: String!) {
      project(id: $projectId) {
        id
        name
        url
        issues(first: 50) {
          nodes {
            id
            identifier
            title
            state {
              name
            }
            assignee {
              name
            }
            labels {
              nodes {
                id
                name
              }
            }
          }
        }
      }
    }`,
    {
      projectId
    }
  );

  if (!data.project) {
    throw new Error(`Could not load Linear project ${projectId}.`);
  }

  return data.project;
}

type ManagedLabelUpdate = {
  addedLabelIds: string[];
  removedLabelIds: string[];
};

async function readManagedTeamLabels(apiKey: string, teamId: string) {
  const data = await linearGraphQL<ProjectLabelsResult>(
    apiKey,
    `query TeamLabels($teamId: String!) {
      team(id: $teamId) {
        id
        labels(first: 100) {
          nodes {
            id
            name
          }
        }
      }
    }`,
    {
      teamId
    }
  );

  if (!data.team) {
    throw new Error(`Could not load Linear team ${teamId}.`);
  }

  return data.team.labels.nodes;
}

function resolveManagedLabelIds(teamLabels: Array<{ id: string; name: string }>, labels: ManagedLabel[]): string[] {
  const ids = labels.map((label) => {
    const match = teamLabels.find((teamLabel) => teamLabel.name.trim().toLowerCase() === label);
    if (!match) {
      throw new Error(`Configured Linear team is missing label \"${label}\".`);
    }
    return match.id;
  });

  return [...new Set(ids)];
}

function buildManagedLabelUpdate(issueLabels: Array<{ id: string; name: string }>, managedLabelIds: string[]): ManagedLabelUpdate {
  const managedNames = new Set<string>(managedLabels);
  const currentManagedLabelIds = issueLabels
    .filter((label) => managedNames.has(label.name.trim().toLowerCase()))
    .map((label) => label.id);

  return {
    addedLabelIds: managedLabelIds.filter((id) => !currentManagedLabelIds.includes(id)),
    removedLabelIds: currentManagedLabelIds.filter((id) => !managedLabelIds.includes(id))
  };
}

async function createIssue(apiKey: string, input: {
  teamId: string;
  projectId: string;
  title: string;
  description?: string;
  labelIds?: string[];
}) {
  const data = await linearGraphQL<IssueCreateResult>(
    apiKey,
    `mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          title
          url
        }
      }
    }`,
    {
      input
    }
  );

  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error('Linear issueCreate did not return an issue.');
  }

  return data.issueCreate.issue;
}

async function updateIssueStatus(apiKey: string, input: {
  issueId: string;
  stateId: string;
}) {
  const data = await linearGraphQL<IssueUpdateResult>(
    apiKey,
    `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          id
          identifier
          title
          url
          state {
            name
          }
        }
      }
    }`,
    {
      id: input.issueId,
      input: {
        stateId: input.stateId
      }
    }
  );

  if (!data.issueUpdate.success || !data.issueUpdate.issue) {
    throw new Error('Linear issueUpdate did not return an issue.');
  }

  return data.issueUpdate.issue;
}

async function updateIssueDescription(apiKey: string, input: {
  issueId: string;
  description: string;
}) {
  const data = await linearGraphQL<IssueUpdateResult>(
    apiKey,
    `mutation IssueDescriptionUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          id
          identifier
          title
          url
          state {
            name
          }
        }
      }
    }`,
    {
      id: input.issueId,
      input: {
        description: input.description
      }
    }
  );

  if (!data.issueUpdate.success || !data.issueUpdate.issue) {
    throw new Error('Linear issue description update did not return an issue.');
  }

  return data.issueUpdate.issue;
}

async function assignIssue(apiKey: string, input: {
  issueId: string;
  assigneeId: string;
}) {
  const data = await linearGraphQL<IssueUpdateResult>(
    apiKey,
    `mutation IssueAssign($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          id
          identifier
          title
          url
          state {
            name
          }
        }
      }
    }`,
    {
      id: input.issueId,
      input: {
        assigneeId: input.assigneeId
      }
    }
  );

  if (!data.issueUpdate.success || !data.issueUpdate.issue) {
    throw new Error('Linear issue assignment did not return an issue.');
  }

  return data.issueUpdate.issue;
}

async function updateIssueLabels(apiKey: string, input: {
  issueId: string;
  addedLabelIds: string[];
  removedLabelIds: string[];
}) {
  const data = await linearGraphQL<IssueUpdateResult>(
    apiKey,
    `mutation IssueLabelUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          id
          identifier
          title
          url
          state {
            name
          }
        }
      }
    }`,
    {
      id: input.issueId,
      input: {
        addedLabelIds: input.addedLabelIds,
        removedLabelIds: input.removedLabelIds
      }
    }
  );

  if (!data.issueUpdate.success || !data.issueUpdate.issue) {
    throw new Error('Linear label update did not return an issue.');
  }

  return data.issueUpdate.issue;
}

async function createIssueComment(apiKey: string, input: {
  issueId: string;
  body: string;
}) {
  const data = await linearGraphQL<CommentCreateResult>(
    apiKey,
    `mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment {
          id
          body
          url
          issue {
            identifier
            title
          }
        }
      }
    }`,
    {
      input
    }
  );

  if (!data.commentCreate.success || !data.commentCreate.comment) {
    throw new Error('Linear commentCreate did not return a comment.');
  }

  return data.commentCreate.comment;
}

async function deleteIssue(apiKey: string, issueId: string) {
  const data = await linearGraphQL<IssueDeleteResult>(
    apiKey,
    `mutation IssueDelete($id: String!) {
      issueDelete(id: $id) {
        success
      }
    }`,
    {
      id: issueId
    }
  );

  if (!data.issueDelete.success) {
    throw new Error('Linear issueDelete did not report success.');
  }
}

async function readViewer(apiKey: string) {
  const data = await linearGraphQL<ViewerResult>(
    apiKey,
    `query Viewer {
      viewer {
        id
        name
        email
      }
    }`,
    {}
  );

  return data.viewer;
}

async function findIssue(apiKey: string, projectId: string, identifier: string) {
  const data = await linearGraphQL<ProjectIssueListResult>(
    apiKey,
    `query IssueLookup($projectId: String!) {
      project(id: $projectId) {
        issues(first: 50) {
          nodes {
            id
            identifier
            title
            state {
              name
            }
            project {
              id
            }
            team {
              id
              states {
                nodes {
                  id
                  name
                  type
                }
              }
            }
            assignee {
              name
            }
            labels {
              nodes {
                id
                name
              }
            }
          }
        }
      }
    }`,
    {
      projectId
    }
  );

  const issues = data.project?.issues.nodes ?? [];
  const exactMatch = issues.find((issue) => issue.identifier === identifier || issue.title === identifier);
  if (exactMatch) {
    return exactMatch;
  }

  const normalizedQuery = identifier.toLowerCase();
  return issues.find((issue) => issue.title.toLowerCase().includes(normalizedQuery)) ?? null;
}

function resolveStateId(states: Array<{ id: string; name: string; type: string }>, status: SupportedStatus): string {
  const normalized = status.toLowerCase();
  const match = states.find((state) => state.name.toLowerCase() === normalized);
  if (match) {
    return match.id;
  }

  const typeFallback = states.find((state) => {
    if (status === 'Todo') {
      return state.type === 'unstarted' || state.type === 'backlog' || state.type === 'triage';
    }
    if (status === 'In Progress') {
      return state.type === 'started';
    }

    return state.type === 'completed';
  });

  if (!typeFallback) {
    throw new Error(`Could not find a workflow state matching \"${status}\".`);
  }

  return typeFallback.id;
}

function printUsage() {
  console.log('Linear CLI');
  console.log('Usage:');
  console.log('  npm run linear -- list');
  console.log('  npm run linear -- create --title "Issue title" [--description "Markdown description"] [--label "feature|bug|safety"]');
  console.log('  npm run linear -- update-status --issue "CAN-123" --status "In Progress"');
  console.log('  npm run linear -- update-description --issue "CAN-123" --description "Updated markdown description"');
  console.log('  npm run linear -- assign --issue "CAN-123" --assignee "me"');
  console.log('  npm run linear -- comment --issue "CAN-123" --body "Validation details"');
  console.log('  npm run linear -- update-labels --issue "CAN-123" --label "feature|bug|safety" [--label "..."]');
  console.log('  npm run linear -- delete --issue "CAN-123"');
}

export async function runLinearCli(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return;
  }

  const command = parseCliArgs(argv);
  const env = await readLinearEnv();
  const projectReference = parseLinearProjectUrl(env.projectUrl);
  const { project, team } = await resolveProject(env.apiKey, projectReference);

  if (command.kind === 'list') {
    const result = await listProjectIssues(env.apiKey, project.id);
    console.log(`${result.name} (${result.url})`);
    if (result.issues.nodes.length === 0) {
      console.log('No issues found.');
      return;
    }

    for (const issue of result.issues.nodes) {
      const assignee = issue.assignee?.name ? ` — ${issue.assignee.name}` : '';
      const labels = issue.labels.nodes.length > 0
        ? ` — labels: ${issue.labels.nodes.map((label) => label.name).join(', ')}`
        : '';
      console.log(`- ${issue.identifier} [${issue.state.name}] ${issue.title}${assignee}${labels}`);
    }
    return;
  }

  if (command.kind === 'create') {
    const labelIds = command.labels.length > 0
      ? resolveManagedLabelIds(await readManagedTeamLabels(env.apiKey, team.id), command.labels)
      : undefined;
    const issue = await createIssue(env.apiKey, {
      teamId: team.id,
      projectId: project.id,
      title: command.title,
      description: command.description,
      labelIds
    });
    console.log(`Created ${issue.identifier}: ${issue.title}`);
    console.log(issue.url);
    return;
  }

  const issue = await findIssue(env.apiKey, project.id, command.issue);
  if (!issue) {
    throw new Error(`Could not find an issue matching \"${command.issue}\".`);
  }
  if (issue.project?.id !== project.id) {
    throw new Error(`Issue ${issue.identifier} does not belong to configured project ${project.name}.`);
  }

  if (command.kind === 'update-status') {
    const stateId = resolveStateId(issue.team.states.nodes, command.status);
    const updated = await updateIssueStatus(env.apiKey, {
      issueId: issue.id,
      stateId
    });

    console.log(`Updated ${updated.identifier} to ${updated.state.name}`);
    console.log(updated.url);
    return;
  }

  if (command.kind === 'update-description') {
    const updated = await updateIssueDescription(env.apiKey, {
      issueId: issue.id,
      description: command.description
    });

    console.log(`Updated description for ${updated.identifier}: ${updated.title}`);
    console.log(updated.url);
    return;
  }

  if (command.kind === 'assign') {
    const viewer = await readViewer(env.apiKey);
    const assigneeToken = command.assignee.trim().toLowerCase();
    const isViewerMatch = assigneeToken === 'me'
      || assigneeToken === viewer.name.toLowerCase()
      || assigneeToken === (viewer.email?.toLowerCase() ?? '');

    if (!isViewerMatch) {
      throw new Error(`Unsupported assignee \"${command.assignee}\". Use \"me\", your Linear display name, or your Linear email.`);
    }

    const updated = await assignIssue(env.apiKey, {
      issueId: issue.id,
      assigneeId: viewer.id
    });

    console.log(`Assigned ${updated.identifier} to ${viewer.name}`);
    console.log(updated.url);
    return;
  }

  if (command.kind === 'comment') {
    const comment = await createIssueComment(env.apiKey, {
      issueId: issue.id,
      body: command.body
    });

    console.log(`Commented on ${issue.identifier}: ${issue.title}`);
    if (comment.url) {
      console.log(comment.url);
    }
    return;
  }

  if (command.kind === 'update-labels') {
    const teamLabels = await readManagedTeamLabels(env.apiKey, team.id);
    const managedLabelIds = resolveManagedLabelIds(teamLabels, command.labels);
    const update = buildManagedLabelUpdate(issue.labels.nodes, managedLabelIds);
    const updated = await updateIssueLabels(env.apiKey, {
      issueId: issue.id,
      addedLabelIds: update.addedLabelIds,
      removedLabelIds: update.removedLabelIds
    });

    console.log(`Updated labels for ${updated.identifier}: ${command.labels.join(', ')}`);
    console.log(updated.url);
    return;
  }

  await deleteIssue(env.apiKey, issue.id);
  console.log(`Deleted ${issue.identifier}: ${issue.title}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runLinearCli(process.argv.slice(2)).catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
