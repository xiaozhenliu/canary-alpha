---
doc_version: 1
doc_status: active
last_updated: 2026-06-01
---

# Contributing to canary-alpha-mcp

Thank you for helping improve `canary-alpha-mcp`. Contributions of all sizes
are welcome, including bug reports, documentation fixes, tests, and focused
feature proposals.

## Before You Start

- Search existing issues before opening a new one.
- Use the [bug report](https://github.com/xiaozhenliu/canary-alpha/issues/new?template=bug_report.yml)
  or [feature request](https://github.com/xiaozhenliu/canary-alpha/issues/new?template=feature_request.yml)
  form when appropriate.
- Read the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report vulnerabilities privately as described in the
  [security policy](SECURITY.md). Do not open a public issue for a suspected
  vulnerability.

For substantial changes, open an issue before starting implementation so the
scope and product fit can be discussed first.

## Development Setup

Prerequisites:

- macOS
- Node.js 22+
- A running [Screenpipe](https://screenpi.pe/onboarding) installation for
  end-to-end runtime checks

Install dependencies:

```bash
npm install
```

Run the server locally over stdio or Streamable HTTP:

```bash
npm run dev:stdio
npm run dev:http
```

See the [Quickstart guide](docs/quickstart.md) for onboarding and managed
service setup.

## Contribution Workflow

1. Fork the repository and create a focused branch from the current public
   branch.
2. Make the smallest coherent change that solves the issue.
3. Add or update tests at the boundary your change affects.
4. Update reader-facing documentation when behavior or configuration changes.
5. Run the required verification commands.
6. Open a pull request and complete the pull-request template.

## Engineering Guidelines

Keep the existing product constraints intact:

- Preserve the independent MCP server architecture.
- Keep both stdio and Streamable HTTP transports working.
- Keep managed HTTP mode bound to `127.0.0.1`.
- Keep data storage local-first.
- Prefer configuration-driven provider changes.
- Keep MCP tools thin and place domain behavior in `src/services/**`.
- Return stable machine-readable `structuredContent` alongside readable MCP
  content where the existing tool contract requires it.

Read the [engineering standards](docs/engineering/code-standards.md) before
changing runtime code.

## Verification

Run the full verification suite before opening a pull request:

```bash
npm run typecheck
npm run build
npm test
```

Add targeted checks when your change affects onboarding, transports, service
lifecycle, privacy controls, retrieval behavior, or MCP result contracts.

## Documentation Changes

Maintained reader-facing documentation uses metadata at the top of each file:

```yaml
---
doc_version: 1
doc_status: active
last_updated: YYYY-MM-DD
---
```

Increment `doc_version` for substantive edits, update `last_updated`, and add
new maintained documents to the
[governed-document inventory](docs/documentation/governed-documents.md).

## Pull Requests

Keep pull requests focused and explain:

- the problem being solved;
- the chosen approach;
- the verification commands you ran;
- any documentation, configuration, or compatibility impact.

By submitting a contribution, you agree that your contribution is licensed
under the repository's [Apache License 2.0](LICENSE).
