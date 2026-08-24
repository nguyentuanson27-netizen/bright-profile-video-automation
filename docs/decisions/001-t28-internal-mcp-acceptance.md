# ADR-001: Run T28 through an internal MCP client

## Status

Accepted

## Date

2026-08-24

## Context

PR #18 needs to accept normalized evidence and a complete structured draft that were produced with ChatGPT, then stop at `review_required` until a human explicitly approves rendering. The previous T28 plan required ChatGPT itself to register a remote custom MCP app, scan its tools, and invoke the write-capable workflow.

That approach adds a ChatGPT workspace-plan and Developer-Mode dependency that is unrelated to the Bright Profile handoff contract. The project operator uses ChatGPT Plus, while the actual deployment already keeps the MCP process bound to loopback and can be reached through an authenticated SSH tunnel.

## Decision

T28 uses the ordinary internal MCP transport:

```text
ChatGPT Plus conversation
  -> operator copies research/evidence and draft material
  -> SSH tunnel to loopback MCP endpoint
  -> internal MCP client
  -> Bright Profile integration API
```

The operator first normalizes ChatGPT-produced research with `normalize_evidence`, then asks ChatGPT for a complete draft whose `sourceIds` use the normalized evidence IDs. The operator submits the resulting `EvidenceBundle` and draft through the internal MCP client.

The public reverse-proxy route for `/mcp` remains withdrawn (HTTP 404). `MCP_NOAUTH_WRITE_ENABLED` stays false except for the recorded, bounded internal write window. Before `approve_video_project` is invoked, the operator must present the persisted draft/evidence to the user and record a separate explicit confirmation.

## Alternatives considered

### Remote ChatGPT custom MCP app

Rejected for this milestone. It depends on ChatGPT workspace features that the single-operator Plus plan does not provide, requires temporary public ingress, and does not add integrity guarantees beyond the existing validated internal handoff.

### Direct Bright Profile integration API calls

Rejected for acceptance. That would require exposing the private service token to the operator client and would bypass the MCP transport being delivered by this PR.

## Consequences

- T28 validates the shipped MCP tool surface with a real internal client, without publishing or registering a ChatGPT app.
- ChatGPT remains the source of research and draft content, but is not treated as an authenticated MCP caller.
- T28 no longer claims to prove ChatGPT tool-selection behavior; it proves the human approval checkpoint through recorded operator action.
- The public MCP endpoint remains closed before, during, and after acceptance.
