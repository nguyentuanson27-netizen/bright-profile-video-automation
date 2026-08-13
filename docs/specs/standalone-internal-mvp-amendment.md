# Amendment: Standalone Bright Profile Internal MVP Scope

**Status:** Active  
**Date:** 2026-08-13  
**Applies to:** `docs/specs/standalone-production-app.md`, `tasks/plan.md`, and `tasks/todo.md`

## Context

The standalone spec and plan were originally framed around production hardening and deployment readiness. The current project goal is narrower: build a standalone **internal** application for one operator/small internal team and remove n8n from the workflow.

The project is not currently targeting commercial distribution, public SaaS operation, or a public production launch.

## Decision

The functional standalone workflow remains the target:

```text
creator/topic
  -> public-source research
  -> evidence normalization
  -> structured generation
  -> human review + approval
  -> media ingest
  -> TTS
  -> Remotion render
  -> MP4
```

The following scope corrections supersede conflicting language in the older spec/plan:

1. **Rename the milestone conceptually** from “Standalone Bright Profile Production App” to **“Standalone Bright Profile Internal MVP.”** The existing filenames may remain unchanged to preserve history and links.
2. **Internal use is the release boundary.** A public/commercial production launch is not a Definition-of-Done requirement for this milestone.
3. **No public SaaS requirements.** Multi-tenancy, public signup, customer isolation, billing, public legal/listing pages, and commercial launch operations are out of scope.
4. **No plugin expansion requirement.** Direct ChatGPT ↔ Bright Evidence MCP use is accepted for the current scope. Codex-specific completion, ChatGPT desktop repo-marketplace installation, and public Plugins Directory publication are not required gates.
5. **Security controls remain in scope where they protect real boundaries.** External input validation, SSRF protection, secret handling, auth for exposed internal endpoints, prompt-injection resistance, MCP Host/Origin/body/rate/deadline controls, non-root containers, and safe artifact handling remain required where applicable.
6. **Deployment hardening is proportional to actual internal use.** TLS/public gateway, production observability, SLOs, multi-host failover, and public launch runbooks are only required if/when the app is intentionally exposed beyond the trusted internal environment.
7. **Durability is still required for the standalone workflow.** Removing production launch scope does not remove the need for persisted project/job state and restart recovery because those are functional requirements of the standalone app.
8. **Human review remains required before TTS/render** for the current MVP unless explicitly changed later.

## Current implementation status

Completed foundation:

- Remotion render core;
- Google TTS integration;
- current authenticated render job API baseline;
- Bright Evidence MCP normalization service;
- remote MCP deployment and ChatGPT tool discovery;
- observed successful `normalize_evidence` invocation with deterministic duplicate removal.

Not yet implemented end-to-end:

- durable standalone project/job state;
- research orchestration;
- structured generation pipeline;
- review/edit/approval persistence;
- trusted approved-media ingest;
- durable multi-stage worker flow;
- standalone operator UI;
- complete n8n-independent creator/topic -> MP4 workflow.

## Consequences for the existing task plan

The older task list remains useful as an implementation decomposition, but interpret production-specific acceptance criteria through this amendment.

Prioritize functional milestones in this order:

1. durable state/domain/workflow foundation;
2. safe public-source research and evidence pipeline;
3. structured generation and approval gate;
4. media ingest + TTS/render worker integration;
5. minimal internal operator UI;
6. end-to-end restart/retry verification.

Do not spend project time on public launch, public plugin distribution, Codex/desktop marketplace packaging, or commercial hardening unless the user explicitly changes scope.

## Success condition for the internal MVP

The milestone is functionally complete when an internal operator can start from a creator/topic and optional public URLs, review the researched/generated draft, approve it, and receive a valid MP4 through the standalone application without using n8n or manually constructing project JSON, with durable state and safe retry/recovery for the supported workflow.
