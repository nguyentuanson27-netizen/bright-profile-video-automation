# Implementation Plan: ChatGPT MCP End-to-End Video Handoff

**Primary spec:** `docs/specs/chatgpt-mcp-e2e-video-handoff.md`  
**Baseline status:** `docs/project-status.md`  
**Completed predecessor milestone:** standalone T01-T16 on `main`  
**Plan status:** Ready for implementation review  
**Implementation status:** Not started  
**Planned task range:** T17-T28

## Goal

Extend the existing Bright Evidence MCP from a read-only evidence-normalization boundary into an authenticated ChatGPT-to-Bright-Profile orchestration surface, while keeping Bright Profile as the sole owner of project state, generation, approval, durable jobs, media/TTS/render, and authoritative MP4 artifacts.

Target default flow:

```text
ChatGPT public research
  -> normalize_evidence
  -> import normalized EvidenceBundle
  -> durable generation
  -> review_required
  -> user review/edit/approve
  -> render pipeline
  -> MP4
```

Target explicit E2E flow:

```text
ChatGPT public research
  -> normalize_evidence
  -> import normalized EvidenceBundle
  -> durable generation
  -> delegated approval safety gate
  -> approval(mode=delegated_e2e)
  -> media ingest
  -> TTS
  -> Remotion render
  -> authoritative MP4 download
```

Default behavior stops at review. Only an explicit user end-to-end request may activate delegated approval, and the backend still owns the final legality checks.

## Baseline to Preserve

T01-T16 are already complete and remain the implementation foundation:

- Node.js ESM app + durable worker;
- SQLite project/source/revision/stage/attempt/artifact state;
- lease renewal, retry, cancel, reclaim, and claim-token fencing;
- OpenAI research/generation providers and deterministic fakes;
- deterministic evidence normalizer under `lib/evidence`;
- structured review/edit/approval barrier;
- SSRF-safe media ingest;
- Google Cloud TTS;
- Remotion render and authoritative output checks;
- same-origin React/Vite operator UI;
- standalone app+worker Compose stack;
- read-only Bright Evidence MCP deployment;
- existing CI, dependency audit, lint, frontend build, health, render-smoke, and Compose/container gates.

This milestone must not recreate any of those systems inside MCP.

## Scope Decisions

### In scope

- authenticated write/cost-bearing MCP tools for the Bright Profile video workflow;
- import of caller-normalized `EvidenceBundle` into the durable backend without rerunning research;
- ChatGPT-visible project status/draft orchestration;
- ChatGPT draft edit and user-reviewed approval;
- explicit delegated-E2E approval mode with server-side safety gates;
- render/retry/cancel controls reusing existing durable semantics;
- safe short-lived delivery of the authoritative MP4;
- MCP-to-app private service integration and least-privilege service credential;
- structured audit/observability for integration request -> project -> revision -> stage -> artifact;
- deterministic integration/E2E regression plus live ChatGPT acceptance.

### Explicit non-goals

- public SaaS, multi-tenant accounts, billing, or public signup;
- new renderer, TTS provider, database, job queue, or evidence engine;
- public Plugins Directory/commercial launch work;
- semantic/LLM conflict resolution;
- automatic truth selection among conflicting claims;
- arbitrary source-count/quality-score thresholds for delegated approval;
- exposing the existing loopback browser API directly to the Internet;
- MCP mounting SQLite or artifact volumes.

## Source/Version Freshness Gate

This milestone changes MCP authentication and side-effect semantics, so current official documentation must be checked during T17 and again before live acceptance:

- current OpenAI/ChatGPT MCP authentication and plugin/server integration behavior;
- current MCP tool annotation/confirmation behavior relevant to write/cost-bearing actions;
- pinned `@modelcontextprotocol/server` APIs used by this repository;
- any reverse-proxy authentication requirements selected for the deployed path.

Planning confirmed that current OpenAI model guidance emphasizes explicit autonomy/approval boundaries for external or costly actions. Exact ChatGPT MCP auth mechanics remain an implementation-time source-driven decision and must not be guessed.

## Architecture Decisions

### 1. ChatGPT orchestrates; Bright Profile executes

MCP exposes a narrow tool surface. Backend services remain authoritative for lifecycle, validation, approval, retry/cancel, and output authority.

### 2. No direct database sharing

MCP communicates with Bright Profile through a private authenticated service API. It does not mount or open `bright-profile.sqlite` and does not access artifact filesystem paths directly.

### 3. Imported research enters at `research_ready`

`create_video_project` revalidates a normalized `EvidenceBundle`, persists source/evidence provenance with origin `chatgpt_mcp`, records a completed/imported research result, moves the project to `research_ready`, and queues the existing generation stage.

It must not call the backend OpenAI research provider again.

### 4. Idempotency is required at the integration boundary

Each project-creation tool call carries an idempotency key. The same authenticated integration request must return the same project result on retry rather than duplicate work.

### 5. Approval modes are explicit durable data

Keep ordinary approval semantics, but record the origin/mode separately:

```text
user_reviewed
delegated_e2e
```

Delegated approval is not equivalent to model-provided `verified`/override flags and cannot bypass existing revision/hash validation.

### 6. Delegated approval is a server-side policy

The backend evaluates evidence/conflict/draft/revision/workflow prerequisites. ChatGPT's prompt or tool call cannot force approval if those conditions fail.

### 7. Write-capable remote MCP is fail-closed without authentication

Do not register/enable durable write/render behavior in a remotely reachable configuration unless the required authenticated boundary and internal service credential are valid.

### 8. Preserve the existing browser boundary

The standalone app remains loopback/private by default. Integration traffic uses a distinct internal route/auth policy rather than weakening the browser Host/Origin boundary.

### 9. Output delivery uses a narrow signed capability

A completed project returns a short-lived signed URL or equivalent bounded capability that can serve only the authoritative MP4 for the bound project/revision/artifact. No arbitrary path/artifact selector is exposed.

### 10. Existing retry/cancel/fencing semantics remain canonical

MCP tools wrap the existing backend controls rather than introducing independent state transitions.

## Dependency Graph

```text
T17 Auth/security/network contract + fail-closed config
  |
  +--> T18 Handoff + approval domain/schema contracts
         |
         +--> T19 SQLite migration + idempotency/audit persistence
                |
                +--> T20 Backend EvidenceBundle import + research_ready/generate slice
                       |
T17 + T20 -----------> T21 MCP backend client + create/get project tools
                              |
                              +--> Checkpoint A

T18 + T19 + T21 ----> T22 ChatGPT draft edit + user-reviewed approval tools
         |
         +----------> T23 Delegated E2E approval gate + approval provenance
                              |
T21 + T22 + T23 ----> T24 Render/retry/cancel MCP controls
                              |
T17 + T19 + T24 ----> T25 Secure authoritative MP4 delivery
                              |
T17 + T21 + T25 ----> T26 Compose/private-network + observability integration
                              |
T20-T26 ------------> T27 Deterministic full E2E/recovery/security regression
                              |
T26 + T27 ----------> T28 Live ChatGPT acceptance + docs/ship readiness
```

## Vertical Slices

### Slice F — Authenticated import foundation (T17-T21)

Prove the new trust boundary before exposing expensive actions.

Deliver:

```text
authenticated MCP
  -> create_video_project(EvidenceBundle)
  -> private authenticated backend request
  -> durable imported project
  -> research_ready
  -> generation queued
  -> get_video_project
```

The hard requirements in this slice are authentication fail-closed behavior, EvidenceBundle revalidation, import idempotency, no backend research provider call, durable reopen, and bounded status reads.

**Checkpoint A:** stop if any write tool can operate unauthenticated, an imported project reruns research, repeated create calls duplicate projects, or imported evidence/provenance does not survive reopen.

### Slice G — Review and approval from ChatGPT (T22-T23)

Deliver:

```text
review_required
  -> get draft
  -> edit with expected revision/hash
  -> user_reviewed approval
```

and, for explicit E2E requests:

```text
review_required
  -> delegated server gate
  -> delegated_e2e approval
```

**Checkpoint B:** prove default mode does not auto-approve; stale hashes fail; model-provided verification is not authorization; conflicts/zero evidence/invalid draft block delegated approval.

### Slice H — Production controls and output (T24-T26)

Deliver:

```text
approved
  -> start render
  -> status polling
  -> legal retry/cancel
  -> completed
  -> signed authoritative MP4 URL
```

**Checkpoint C:** prove repeated render-start is idempotent, retry/cancel retain existing durable behavior, signed URLs cannot escape the authoritative artifact, and the integration path does not broaden the browser/API public boundary.

### Slice I — End-to-end closure (T27-T28)

Deliver deterministic and live acceptance for both product modes.

Default acceptance:

```text
research -> normalize -> import -> generate -> review_required -> STOP
```

Explicit E2E acceptance:

```text
research -> normalize -> import -> generate -> delegated approval -> render -> MP4
```

**Final checkpoint:** full existing verification + new integration/security tests + live ChatGPT evidence + project-wide Definition of Done.

## Task Summary

| Task | Outcome | Depends on | Scope |
|---|---|---|---|
| T17 | Auth/security/network contract and fail-closed integration config | None | M |
| T18 | Handoff schemas + explicit approval-mode domain contract | T17 | M |
| T19 | SQLite migration for integration idempotency/origin/approval audit | T18 | M |
| T20 | Backend EvidenceBundle import -> `research_ready` -> generation | T19 | M |
| T21 | MCP backend client + `create_video_project` / `get_video_project` | T17,T20 | M |
| T22 | `edit_video_draft` + `user_reviewed` approval path | T18,T19,T21 | M |
| T23 | Delegated-E2E approval gate + durable provenance | T18,T19,T21 | M |
| T24 | `start_video_render` / retry / cancel MCP controls | T21,T22,T23 | M |
| T25 | Signed authoritative MP4 delivery | T17,T19,T24 | M |
| T26 | Compose/private network + structured observability | T17,T21,T25 | M |
| T27 | Deterministic full E2E, recovery, idempotency, security regression | T20-T26 | M |
| T28 | Live ChatGPT default-review + explicit-E2E acceptance and docs closure | T26,T27 | M |

No planned task should intentionally exceed one focused session. If implementation discovery pushes a task beyond roughly five files or across independent subsystems, split it before coding rather than widening the task silently.

## Task Details

### T17 — Authentication, threat model, and private service-boundary foundation

Resolve the highest-risk dependency first. Verify current official OpenAI/ChatGPT MCP authentication guidance and the pinned MCP server APIs. Define the trust boundaries, the external authenticated MCP identity, the internal MCP->app service credential, and fail-closed configuration behavior before any new write tool can operate.

Expected deliverables:

- documented auth decision/ADR or spec amendment if the chosen mechanism materially changes this plan;
- bounded config for internal backend URL/service credential and write-tool enablement;
- authentication/authorization middleware or adapter at the appropriate boundary;
- negative tests for missing/invalid credentials;
- secrets excluded from responses/logs.

### T18 — Handoff and approval domain contracts

Define validated schemas/errors for imported EvidenceBundle handoff, idempotency key, project status response, expected revision/hash editing, and explicit `user_reviewed` vs `delegated_e2e` approval modes.

Keep these contracts independent of HTTP/MCP transport so both the backend and MCP wrappers share the same semantics.

### T19 — Durable integration identity and approval provenance

Add the minimum forward-only migration/repository changes required to survive restart and audit remote actions. Prefer existing JSON columns/records where they can represent imported evidence cleanly; add schema only where durability/idempotency/approval provenance otherwise cannot be guaranteed.

Do not persist secrets or full conversations.

### T20 — Backend imported-research vertical slice

Add one internal authenticated backend operation that revalidates the EvidenceBundle, creates/reuses the project by idempotency key, persists application-owned sources/evidence/origin, records imported research completion, reaches `research_ready`, and enqueues existing generation.

The implementation must prove the research provider is not called for imported projects.

### T21 — First MCP orchestration slice

Add a bounded MCP backend client plus `create_video_project` and `get_video_project` tools. The MCP handler validates input, calls the internal backend, sanitizes failures, and returns bounded structured state. Business rules stay backend-side.

Complete Checkpoint A before continuing.

### T22 — Review/edit and user-reviewed approval

Expose current draft/status through the orchestration response, add revision/hash-fenced edit, and add user-reviewed approval. Reuse existing `createApprovalService` validation rather than duplicating approval rules in MCP.

Default ChatGPT workflow must stop at review until the user explicitly approves/continues.

### T23 — Delegated end-to-end approval

Extend approval services/storage with an explicit delegated approval mode and a server-side gate requiring conflict-free retained evidence, valid draft/source references, exact current revision/hash, valid workflow state, and authenticated delegated authorization context.

Keep `delegated_e2e` audit-distinct from ordinary human/user review.

Complete Checkpoint B before production controls.

### T24 — Render, retry, and cancel MCP controls

Add MCP wrappers for existing backend render-start, retry, and cancel operations. Do not add new transition logic to MCP. Tool availability/results must reflect durable backend legality and existing idempotency/fencing.

### T25 — Secure completed-output delivery

Implement a narrow signed download capability for the current authoritative MP4. Reuse current output validation; do not allow project-controlled path selection. Prefer stateless signed tokens unless a documented correctness/security requirement requires persistence.

### T26 — Runtime integration and observability

Connect MCP and Bright Profile over the intended private network without publishing the worker or weakening browser/API Host/Origin boundaries. Add structured request/action tracing across MCP request -> idempotency key -> project -> revision -> stage/artifact and verify credentials are redacted.

Complete Checkpoint C before final E2E.

### T27 — Deterministic full E2E and adversarial regression

Add a deterministic end-to-end test from candidate evidence through normalization/import/generation/delegated approval/media/TTS/render/output using fakes where remote providers would otherwise be paid/non-deterministic.

Also cover restart/reopen, duplicate tool calls, stale revision approval, unauthorized calls, conflict blocking, retry/cancel, stale-worker fencing, and signed-download tampering/expiry.

### T28 — Live ChatGPT acceptance and documentation closure

Run two real ChatGPT flows against the authenticated deployed MCP integration:

1. default-review flow reaches `review_required` and does not auto-approve;
2. explicit end-to-end flow reaches an accessible authoritative MP4.

Record actual environment/tool evidence, then update current status/integration docs to implemented truth. Keep the existing standalone browser smoke follow-up separate unless this work discovers/fixes a browser-facing defect.

## Parallelization

Safe after contracts are frozen:

- T25 signed-download unit design can be prepared in parallel with T24 once T17/T19 security/storage decisions are stable;
- documentation/test fixture preparation can run alongside implementation tasks;
- focused tests for already-frozen schemas can be authored in RED before implementation.

Must remain sequential:

- T17 before write-capable MCP exposure;
- T18 before storage/API/tool contract implementation;
- T19 before durable import/approval provenance;
- T20 before MCP create/status tools;
- T23 before delegated render flow;
- T26/T27 before live acceptance.

## Major Risks and Mitigations

### Risk 1: write-capable MCP remains unauthenticated

**Impact:** unauthorized project creation/provider spend/render work.  
**Mitigation:** T17 is first; fail-closed config; do not ship or enable write tools until auth negative tests and deployed boundary are proven.

### Risk 2: imported evidence is trusted because it already passed MCP normalization

**Impact:** malformed/stale/forged backend state.  
**Mitigation:** backend revalidates the complete handoff contract and owns all application IDs/source records.

### Risk 3: delegated E2E becomes a prompt-only bypass

**Impact:** unsafe auto-approval.  
**Mitigation:** explicit durable approval mode + server-side gate + revision/hash binding + conflict/zero-evidence/draft validation.

### Risk 4: remote retries duplicate projects/renders

**Impact:** duplicate provider spend and artifacts.  
**Mitigation:** integration idempotency key, existing first-descendant transaction, repeated-tool regressions.

### Risk 5: output URL becomes arbitrary file access

**Impact:** filesystem/artifact disclosure.  
**Mitigation:** capability bound to authoritative project/revision/artifact, short expiry, existing size/hash/path validation, no caller path selector.

### Risk 6: integration weakens existing browser/private topology

**Impact:** accidental public standalone API exposure.  
**Mitigation:** separate private integration route/auth, worker remains unexposed, browser Host/Origin policy remains unchanged.

### Risk 7: live ChatGPT behavior differs from test harness assumptions

**Impact:** tools not discovered/confirmed/called as expected.  
**Mitigation:** current official docs re-check in T17 and T28 plus two explicit live acceptance runs before closure.

## Verification Checkpoints

### Checkpoint A — Import boundary

Require all of:

- authenticated write path proven fail-closed;
- imported EvidenceBundle revalidated;
- no backend research provider call;
- durable evidence/source/origin survives reopen;
- repeated create idempotency returns one project;
- create/get MCP tools return sanitized bounded results.

### Checkpoint B — Approval boundary

Require all of:

- default mode stops at `review_required`;
- stale edit/approval hashes fail;
- `user_reviewed` works only for valid current draft;
- `delegated_e2e` is audit-distinct;
- conflicts, zero evidence, invalid draft/source references, invalid state block delegated approval;
- model verification/override text does not grant approval authority.

### Checkpoint C — Production/output boundary

Require all of:

- render/retry/cancel wrap existing durable state machine;
- repeated render-start does not duplicate downstream stages;
- signed output serves only current authoritative MP4;
- expired/tampered download capability fails closed;
- Compose/private network works without exposing worker/browser API publicly;
- integration logs correlate actions without leaking secrets.

### Final Checkpoint — Milestone closure

Require:

- focused RED->GREEN tests for each changed behavior;
- full `npm test`;
- `npm run lint`;
- `npm run audit:standalone`;
- frontend build remains green;
- SQLite migration/reopen checks;
- MCP process/container verification;
- standalone app+worker Compose verification;
- deterministic full E2E;
- live ChatGPT default-review acceptance;
- live ChatGPT explicit-E2E acceptance;
- project-wide Definition of Done;
- documentation updated to current implemented truth.

## Definition of Done Additions for This Milestone

In addition to the shared project Definition of Done:

- no unauthenticated durable write/render MCP path;
- no MCP direct SQLite/artifact-volume access;
- default human review behavior demonstrably preserved;
- delegated approval demonstrably server-gated and audit-distinct;
- integration idempotency demonstrably prevents duplicate project/render work;
- completed MP4 delivery demonstrably cannot select arbitrary files;
- live ChatGPT evidence proves both product modes on the actual deployed integration.

## Plan Exit Condition

Planning is complete when this plan and `tasks/todo.md` are reviewed against the approved spec. `/build` should start at T17 and must not skip directly to adding MCP write tools before the authentication/private-service boundary is resolved and tested.
