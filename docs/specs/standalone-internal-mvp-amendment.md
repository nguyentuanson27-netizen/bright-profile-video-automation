# Amendment: Standalone Bright Profile Internal MVP Scope

**Status:** Active  
**Date:** 2026-08-13  
**Applies to:** `docs/specs/standalone-production-app.md`, `tasks/plan.md`, `tasks/todo.md`, and `tasks/traceability.md`

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
5. **Security controls remain in scope where they protect real boundaries.** External input validation, SSRF protection, secret handling, auth for exposed internal endpoints, prompt-injection resistance, MCP Host/Origin/body/rate/deadline controls, non-root containers, dependency-risk review, and safe artifact handling remain required where applicable.
6. **Deployment hardening is proportional to actual internal use.** TLS/public gateway, production observability, SLOs, multi-host failover, and public launch runbooks are only required if/when the app is intentionally exposed beyond the trusted internal environment.
7. **Durability is still required for the standalone workflow.** Removing production launch scope does not remove the need for persisted project/job state and restart recovery because those are functional requirements of the standalone app.
8. **Human review remains required before media ingest/TTS/render** for the current MVP unless explicitly changed later.
9. **The current MVP contract is frozen through `tasks/traceability.md`.** Historical functional details are current requirements only when retained by the higher-precedence current-scope documents or explicitly listed in that matrix.

## Frozen observable flow

The required operator-facing flow for this MVP is:

```text
create
  -> research
  -> generate
  -> review/edit
  -> approve
  -> render-start
  -> media ingest
  -> TTS
  -> render
  -> download
```

The retained HTTP/application controls include project create/list/read, research, generation, draft edit, approval, render-start, retry/cancel, source read, authoritative completed-output download, and liveness/readiness. Exact route ownership and focused regressions are recorded in `tasks/traceability.md`.

## Traceability closure rule

`tasks/traceability.md` is binding for planning closure. Every retained observable operation/state/security invariant must have:

`requirement/source -> owner task -> implementation surface -> focused regression -> final E2E/CI gate`.

The plan is not ready for `/build` if any retained row is orphaned.

A historical requirement that appears only in `docs/specs/standalone-production-app.md` does not become a current MVP gate by omission. If it is not retained by `docs/project-status.md`, this amendment, or `tasks/traceability.md`, it is deferred until an explicit scope change.

Examples explicitly deferred for this internal MVP:

- add/remove public source URLs after creation and rerun research;
- regenerate an already reviewable draft from the same source set;
- rerender an already completed approved revision as a new run;
- separate raw approved-manifest export/download;
- full metrics/SLO/disk-pressure observability platform;
- production retention/backup/cleanup policy and release/rollback operations;
- public TLS/auth/OAuth/browser-account work while the app remains private/loopback/trusted-network only.

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
- standalone render-start/output-download/health API surface;
- standalone operator UI;
- complete n8n-independent creator/topic -> MP4 workflow.

## Consequences for the existing task plan

The current task plan remains the implementation decomposition. `tasks/traceability.md` supplies binding ownership addenda where an observable contract was previously advertised but lacked an explicit task owner, including:

- T08: `/health/live` and `/health/ready` implementation;
- T10: successful `POST /api/projects/:id/render` render-start transaction;
- T12: authoritative `GET /api/projects/:id/artifacts/output` download contract;
- T16: final deterministic E2E must use those real HTTP/application controls rather than bypassing them through direct service calls.

Prioritize functional milestones in this order:

1. durable state/domain/workflow foundation;
2. safe public-source research and evidence pipeline;
3. structured generation and approval gate;
4. render-start + media ingest + TTS/render worker integration;
5. minimal internal operator UI;
6. end-to-end restart/retry/download verification.

Do not spend project time on public launch, public plugin distribution, Codex/desktop marketplace packaging, or commercial hardening unless the user explicitly changes scope.

## Success condition for the internal MVP

The milestone is functionally complete when an internal operator can start from a creator/topic and optional public URLs, review the researched/generated draft, approve it, start the downstream render workflow, and receive a valid MP4 through the standalone application without using n8n or manually constructing project JSON, with durable state and safe retry/recovery for the supported workflow.

Completion also requires the frozen traceability matrix to have no orphan retained requirement and the project-wide Definition of Done to pass.
