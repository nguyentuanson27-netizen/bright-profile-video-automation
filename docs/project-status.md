# Bright Profile — Current Project Status

**Status date:** 2026-08-21  
**Authoritative scope:** completed standalone internal MVP baseline (T01-T16) plus an in-progress ChatGPT MCP video-handoff milestone (T17-T28) that has been reset to temporary external `noauth`, private MCP-to-app service authentication, and `user_reviewed` approval only.  
**Lifecycle:** standalone T01-T16 repository promotion complete; ChatGPT MCP implementation exists on PR #18 but its OAuth/delegated-E2E contract has been superseded by the 2026-08-21 no-auth amendment; implementation rework, exact-head verification, and live ChatGPT acceptance remain open.

## Current objective

The standalone internal MVP has been promoted to the default branch `main` and remains the execution baseline.

The active PR #18 objective is now to connect ChatGPT public-source research through Bright Evidence MCP into the existing Bright Profile backend with the smallest coherent temporary integration contract:

```text
ChatGPT
  -> no-auth MCP
  -> normalize/import EvidenceBundle
  -> durable generation
  -> review_required
  -> user reviews/confirms in ChatGPT
  -> user_reviewed approval
  -> render pipeline
  -> authoritative MP4
```

OAuth, DCR, user login/session handling, static external bearer authentication, authenticated user identity propagation, and `delegated_e2e` approval are deferred to a later trust-boundary milestone.

## Standalone baseline state

Current repository baseline state remains:

- promotion PR #13 (`spec/standalone-production-app -> main`) merged on 2026-08-15;
- pre-promotion `main`: `54d7ce5bd4d72b376e923a2969297762e261b4fe`;
- final PR #13 head: `b4fa4d73dd258eefe336420cbf9d09e5743980a1`;
- resulting `main` merge commit: `4f8344de2dbd9963a5d4b3a96e6aeeb19d36e098`;
- post-merge `main` push workflow `31837273738`: **SUCCESS** on that merge commit;
- post-promotion documentation sync PR #16 merged to `main` as `d7637dfccd05e0ccba5a17a9d86d096446efef7d`;
- repository promotion alone did not imply a runtime deployment.

The repository owner explicitly accepted the residual browser/UI risk and authorized a **one-time browser-smoke waiver for PR #13** in PR conversation comment `5297075013`. The real-browser keyboard/focus/console walkthrough was **not run and must not be recorded as passed**. It remains a separate follow-up verification item for the standalone milestone.

Frozen standalone operator flow:

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

## Milestone state: ChatGPT MCP video handoff

The milestone is specified by `docs/specs/chatgpt-mcp-e2e-video-handoff.md` and planned/tracked in `tasks/plan.md`, `tasks/todo.md`, and the ChatGPT MCP section of `tasks/traceability.md`.

### Current target architecture

```text
ChatGPT
  |
  | noauth MCP transport
  v
Bright Evidence MCP
  |
  | BRIGHT_INTEGRATION_TOKEN
  | private/internal network
  v
Bright Profile integration API
  |
  `-> durable worker -> media/TTS/render -> authoritative MP4
```

The external MCP surface is intentionally unauthenticated for this temporary milestone. This must not be represented as production-secure anonymous write access. Anyone who can reach the MCP endpoint can invoke exposed tools, so network exposure must remain intentionally constrained until authenticated external access is reintroduced later.

### Current supported ChatGPT flow

```text
ChatGPT public research
  -> normalize_evidence
  -> import EvidenceBundle into Bright Profile
  -> durable generation
  -> review_required
  -> user review/edit/confirm
  -> user_reviewed approval
  -> media ingest
  -> TTS
  -> render
  -> authoritative MP4
```

### Deferred flow

The previous explicit autonomous flow:

```text
review_required
  -> delegated_e2e approval
  -> render
```

is no longer part of the current milestone. It is deferred until a later authenticated user-authorization boundary exists. Model/tool arguments are not trusted as delegated authorization evidence.

## Current implementation truth

Before the 2026-08-21 scope reset, PR #18 accumulated implementation for OAuth/DCR/session handling and delegated approval. Review repeatedly found that those mechanisms did not provide a trustworthy project-specific human authorization boundary and introduced excessive auth complexity inside the MCP server.

The new authoritative docs therefore intentionally move ahead of the code so implementation can be simplified against one coherent contract.

Current truth after the docs reset:

- standalone T01-T16: **complete and promoted**;
- ChatGPT handoff domain/import/render/download foundations: **implemented baseline exists on PR #18**;
- external MCP auth target: **changed to noauth; code reset pending**;
- private MCP -> app auth: **must remain `BRIGHT_INTEGRATION_TOKEN`**;
- approval target: **`user_reviewed` only; contract cleanup pending**;
- OAuth/DCR/session/static external bearer code/config: **deferred; removal pending**;
- delegated E2E/delegation grants: **deferred; removal from active surface pending**;
- deterministic noauth E2E: **not yet re-verified**;
- exact-head CI after the reset implementation: **not yet recorded**;
- live ChatGPT noauth acceptance: **not yet run**;
- T28: **open**.

Do not reuse earlier green CI or test counts as evidence that the reset contract is complete. Fresh exact-head verification is required after the implementation changes land.

## Required security/integrity boundaries after the reset

The following controls remain mandatory:

- `BRIGHT_INTEGRATION_TOKEN` protects the private MCP-to-Bright-Profile integration API;
- direct missing/wrong service-token calls fail closed with zero durable mutation;
- MCP never mounts the Bright Profile SQLite database or artifact volume;
- worker remains unexposed;
- browser Host/Origin boundary remains private/loopback-oriented;
- request body size, request deadline, rate limit, protocol validation, and secret-safe logging remain enabled on MCP;
- public URL/media fetches remain SSRF-safe and bounded by DNS/IP, redirect, MIME, byte, and timeout policies;
- provider/model output remains untrusted and locally schema/source validated;
- approval remains bound to exact current revision/hash and legal state;
- stale/reclaimed/cancelled workers cannot publish authoritative artifacts;
- media/output files remain application-owned and integrity-checked;
- completed MP4 delivery remains protected by a short-lived signed capability bound to exact project/revision/artifact;
- download proxy remains streaming/backpressure-aware and cannot select arbitrary files.

The reset intentionally removes external authentication as a control for this milestone. It must not be listed among retained protections until a future auth milestone actually implements and verifies it.

## Implemented standalone surface

The promoted standalone baseline includes:

- durable SQLite project/source/revision/stage/attempt/artifact state with migrations and restart-safe reopen;
- lease, heartbeat, claim-token fencing, bounded retry, cancel, reclaim, and stale-owner rejection;
- creator/topic public-source research and normalized evidence/source provenance;
- structured generation of claims, script, voiceover chunks, and supported Remotion scenes;
- local schema/reference/timeline validation of model output and explicit distrust of model verification/override assertions;
- structured human review/edit and immutable approval with edit-vs-downstream serialization;
- approved-media ingest through the SSRF-safe fetch boundary into application-owned attempt paths;
- source/revision-bound media manifests plus authoritative artifact size/SHA-256 metadata;
- durable Google TTS and Remotion render stages with retry/cancel/recovery semantics;
- normal renderer inputs restricted to application-controlled local media with Chromium web security enabled;
- authoritative completed-output MP4 download with path/size/hash revalidation;
- React/Vite same-origin operator UI for create, status, research, evidence/conflicts, draft review/edit, approve, render, retry, cancel, and download;
- standalone Docker image and two-service Compose topology: loopback-published app + non-published worker sharing one named data volume;
- removal of n8n and manually constructed project JSON from the normal operator workflow;
- deterministic fake-provider full-flow regression that reaches a downloadable authoritative MP4 without remote provider calls;
- frontend build, aggregate lint, dependency audit, health, render smoke, Compose/container, and retained MCP regression gates in CI.

## Verification evidence retained from completed standalone work

### Implementation closure

PR #11 completed T14-T16 and merged into `spec/standalone-production-app` on 2026-08-14. GitHub Actions run `31799285582` completed **SUCCESS** on exact head `ec82a6fe551d34b1128fe9fa920b5edd0fe412bd`.

### Release closure

PR #12 (`ship: close standalone MVP release gates`) merged into `spec/standalone-production-app` as commit `5594bc16d9ce30c5155a0f5ec4bb261bdaf431cf`.

- PR #12 exact-head workflow `31806106643`: **SUCCESS**.
- post-merge source-branch push workflow `31825258653` on `5594bc16d9ce30c5155a0f5ec4bb261bdaf431cf`: **SUCCESS**.

### Promotion closure

PR #13 promoted the integrated milestone to `main`.

- prior promotion workflow `31826285093`, attempt 2, passed on exact head `07a079a6bb5ae44e66c15a8b248cde0e6e2a6868` after a transient Chrome-start timeout in attempt 1;
- the browser-smoke waiver/documentation synchronization moved the final PR head to `b4fa4d73dd258eefe336420cbf9d09e5743980a1` and fresh exact-head verification was completed before merge;
- PR #13 merged to `main` as `4f8344de2dbd9963a5d4b3a96e6aeeb19d36e098`;
- post-merge `main` workflow `31837273738` completed **SUCCESS** on that exact merge commit;
- PR #16 later synchronized the active standalone spec/status documentation and merged as current `main` commit `d7637dfccd05e0ccba5a17a9d86d096446efef7d`.

Standalone repository promotion is therefore complete. This statement does **not** claim that the waived browser walkthrough passed and does **not** claim that repository promotion itself deployed a runtime host.

## Current verification gates for PR #18

Before the ChatGPT MCP milestone may be called complete, all of the following require fresh evidence on the reset implementation:

- [ ] MCP initialize/tool discovery/legal calls work without Authorization.
- [ ] active tools advertise `noauth`.
- [ ] OAuth/DCR/session/static external bearer runtime/config is removed.
- [ ] private MCP -> app service authentication remains fail-closed.
- [ ] active MCP approval contract is `user_reviewed` only.
- [ ] delegated E2E/delegation grants are deferred and unreachable from active MCP input.
- [ ] deterministic noauth full E2E reaches authoritative MP4.
- [ ] existing standalone/security/fencing/download regressions remain green.
- [ ] exact-head `Bright Profile Verification` succeeds after reset implementation.
- [ ] live ChatGPT Path A reaches `review_required` without OAuth linking and without premature approval/render.
- [ ] live ChatGPT Path B performs user-reviewed approval, render, and playable MP4 retrieval.
- [ ] project-wide Definition of Done is checked.
- [ ] final docs and PR body reflect observed exact-head truth.

## Frozen MVP contract and traceability

`tasks/traceability.md` remains the closure ledger for the completed T01-T16 standalone milestone and now also contains an **open** ChatGPT MCP noauth-reset matrix for T17-T28.

T01-T16 remain complete; reopening T17-T28 does not reopen the standalone baseline.

## Current non-goals

Unless explicitly reintroduced later, neither the completed standalone baseline nor the current noauth handoff milestone requires:

- public SaaS or multi-tenant behavior;
- commercial launch readiness;
- public Plugins Directory submission;
- publisher/business verification or public legal/listing pages;
- Codex-specific plugin completion;
- ChatGPT desktop repo-marketplace acceptance as a standalone completion goal;
- Kubernetes, multi-region infrastructure, or other scale architecture not needed by the internal workflow;
- a second renderer/job queue/evidence engine inside MCP;
- arbitrary automatic truth resolution for conflicting evidence;
- production OAuth/OIDC or account management in the current reset milestone;
- delegated autonomous approval in the current reset milestone.
