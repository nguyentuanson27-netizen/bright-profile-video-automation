# Standalone app/worker dependency audit

Status: current for T01 of the Standalone Bright Profile Internal MVP.

This record applies to the repository-root production dependency graph used by the standalone app/worker. `docs/security/mcp-dependency-audit.md` remains MCP-specific and is not standalone acceptance evidence.

## Runtime graph

T01 adds exact direct pins for `better-sqlite3@13.0.1` and `openai@6.49.0`. Existing direct dependency pins remain unchanged. The committed root lockfile is authoritative.

The standalone review includes the reachable renderer/bundler graph, Ajv application-schema validation path, planned SQLite state path, and planned OpenAI provider path. This is intentionally broader than the MCP runtime boundary.

## Executable gate

`npm run audit:standalone` runs the standalone policy in `security/standalone-audit-policy.mjs` against the root production graph.

The policy validates the structured npm audit report and process status, requires internally consistent severity counts, and accepts only a graph with zero high or critical production findings. T01 has no standalone severity allowlist. Malformed or incomplete reports, inconsistent counts, unexpected process status, or any high/critical finding fail closed.

MCP audit policy and regression evidence remain separate. T16 may compose this executable T01 gate into broader lifecycle CI without changing the standalone audit boundary.
