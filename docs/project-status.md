# Bright Profile — Current Project Status

**Status date:** 2026-08-21  
**Authoritative scope:** completed standalone internal MVP baseline (T01-T16) plus an in-progress ChatGPT MCP video-handoff milestone (T17-T28) reset to temporary external `noauth`, private MCP-to-app service authentication, bounded anonymous writes, and external review acknowledgment semantics.  
**Lifecycle:** standalone T01-T16 repository promotion complete; ChatGPT MCP implementation exists on PR #18 but the earlier OAuth/delegated-E2E contract is superseded; implementation rework, exact-head verification, and live ChatGPT acceptance remain open.

## Current objective

The standalone internal MVP has been promoted to `main` and remains the execution baseline.

The active PR #18 objective is now:

```text
ChatGPT
  -> no-auth MCP
  -> normalize/import EvidenceBundle
  -> durable generation
  -> review_required
  -> draft/evidence shown in ChatGPT
  -> user confirms/continues in the tested ChatGPT flow
  -> approve_video_project
  -> external review acknowledgment
  -> render pipeline
  -> authoritative MP4
```

OAuth, DCR, user login/session handling, static external bearer authentication, authenticated user identity propagation, server-verifiable human-review provenance, and `delegated_e2e` approval are deferred to a later trust-boundary milestone.

## Approval truth in temporary noauth mode

The docs no longer treat `user_reviewed` as a server-verifiable human-review invariant.

Current contract:

- the backend guarantees it does not auto-approve at `review_required`;
- revision/hash/state/draft/source legality remains server-enforced;
- the live ChatGPT acceptance flow must demonstrate that the tested client waits for user confirmation before calling approval;
- an arbitrary anonymous caller can still invoke approval while noauth writes are enabled, so the backend cannot prove a real human reviewed the draft;
- docs/tests/logs use **external review acknowledgment** as the semantic description;
- audit origin is a bounded integration value such as `chatgpt_mcp_noauth`, not a claimed human identity;
- if the current database continues to store `approval_mode='user_reviewed'`, that value is legacy compatibility data for external review acknowledgment only and must not be presented as authenticated human proof.

## Temporary noauth deployment posture

Anonymous write access is intentionally **default-off** and may be enabled only for a bounded internal acceptance/test window.

Target guardrails:

```text
MCP_NOAUTH_WRITE_ENABLED=false
MCP_RATE_LIMIT_PER_MINUTE=20
MCP_MAX_INFLIGHT_WRITE_REQUESTS=2
MCP_MAX_ACTIVE_PROJECTS=3
```

Required behavior:

- write/cost-bearing tools fail with `NOAUTH_WRITE_DISABLED` before side effects when the kill switch is false;
- no noauth limit defaults to unlimited;
- excess active-project creation fails with `NOAUTH_CAPACITY_REACHED` without creating another project;
- app/browser API stays private/loopback-oriented;
- ChatGPT remote access uses the intended HTTPS MCP ingress only;
- T28 may enable writes only for the acceptance window and must record enable/config values;
- after acceptance, writes are disabled and/or external ingress is withdrawn, with teardown evidence recorded.

This is a single-operator/internal acceptance posture, not a public multi-user service.

## Standalone baseline state

Current repository baseline remains:

- promotion PR #13 (`spec/standalone-production-app -> main`) merged on 2026-08-15;
- pre-promotion `main`: `54d7ce5bd4d72b376e923a2969297762e261b4fe`;
- final PR #13 head: `b4fa4d73dd258eefe336420cbf9d09e5743980a1`;
- resulting `main` merge commit: `4f8344de2dbd9963a5d4b3a96e6aeeb19d36e098`;
- post-merge `main` workflow `31837273738`: **SUCCESS**;
- post-promotion documentation sync PR #16 merged as `d7637dfccd05e0ccba5a17a9d86d096446efef7d`;
- repository promotion alone did not imply a runtime deployment.

The repository owner accepted a one-time browser-smoke waiver for PR #13 in conversation comment `5297075013`. The real-browser keyboard/focus/console walkthrough was not run and must not be recorded as passed.

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

T01-T16 remain complete; reopening T17-T28 does not reopen the standalone baseline.

## Milestone state: ChatGPT MCP video handoff

The active milestone is specified by `docs/specs/chatgpt-mcp-e2e-video-handoff.md`, planned in `tasks/plan.md`, tracked in `tasks/todo.md`, and mapped in Ledger B of `tasks/traceability.md`.

### Target architecture

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

### Current implementation truth

Before the 2026-08-21 scope reset, PR #18 accumulated implementation for OAuth/DCR/session handling and delegated approval. Review found those mechanisms did not provide a trustworthy project-specific human authorization boundary and introduced excessive auth complexity inside the MCP server.

Current truth after the docs reset:

- standalone T01-T16: **complete and promoted**;
- ChatGPT handoff domain/import/render/download foundations: **implemented baseline exists on PR #18**;
- external MCP auth target: **changed to noauth; code reset pending**;
- private MCP -> app auth: **must remain `BRIGHT_INTEGRATION_TOKEN`**;
- approval target: **external review acknowledgment; contract/code cleanup pending**;
- legacy stored `user_reviewed`: **allowed only as compatibility representation, not human-proof semantics**;
- OAuth/DCR/session/static external bearer code/config: **deferred; removal pending**;
- delegated E2E/delegation grants: **deferred; removal from active surface pending**;
- noauth write kill switch/capacity controls: **specified; implementation pending**;
- deterministic noauth E2E: **not yet re-verified**;
- exact-head CI after reset implementation: **not yet recorded**;
- live ChatGPT noauth acceptance: **not yet run**;
- T28: **open**.

Earlier green CI/test counts for OAuth/delegated implementations do not verify the reset contract.

## Required security/integrity boundaries after the reset

The following controls remain mandatory:

- `BRIGHT_INTEGRATION_TOKEN` protects the private MCP-to-Bright-Profile integration API;
- direct missing/wrong service-token calls fail closed with zero durable mutation;
- MCP never mounts the Bright Profile SQLite database or artifact volume;
- worker remains unexposed;
- browser/app Host/Origin boundary remains private/loopback-oriented;
- noauth writes are disabled by default;
- request body size, request deadline, finite rate limit, finite write concurrency, active-project cap, protocol validation, and secret-safe logging remain enabled on MCP;
- public URL/media fetches remain SSRF-safe and bounded by DNS/IP, redirect, MIME, byte, and timeout policies;
- provider/model output remains untrusted and locally schema/source validated;
- approval remains bound to exact current revision/hash and legal state;
- audit does not claim authenticated human identity in noauth mode;
- stale/reclaimed/cancelled workers cannot publish authoritative artifacts;
- media/output files remain application-owned and integrity-checked;
- completed MP4 delivery remains protected by a short-lived signed capability bound to exact project/revision/artifact;
- download proxy remains streaming/backpressure-aware and cannot select arbitrary files.

External authentication is intentionally absent from the current milestone and must not be listed among retained protections.

## Implemented standalone surface

The promoted standalone baseline includes:

- durable SQLite project/source/revision/stage/attempt/artifact state with restart-safe reopen;
- lease, heartbeat, claim-token fencing, bounded retry, cancel, reclaim, and stale-owner rejection;
- creator/topic public-source research and normalized evidence/source provenance;
- structured generation and local schema/source/timeline validation;
- structured human review/edit and immutable approval with edit-vs-downstream serialization;
- SSRF-safe approved-media ingest into application-owned artifact paths;
- Google TTS and Remotion render stages with retry/cancel/recovery semantics;
- authoritative completed-output MP4 validation/download;
- React/Vite same-origin operator UI;
- loopback-published app + non-published worker Compose topology;
- deterministic fake-provider standalone full-flow regression;
- frontend build, lint, dependency audit, health, render smoke, Compose/container, and retained MCP regression gates in CI.

## Verification evidence retained from completed standalone work

PR #11 completed T14-T16; workflow `31799285582` succeeded on exact head `ec82a6fe551d34b1128fe9fa920b5edd0fe412bd`.

PR #12 release closure workflow `31806106643` succeeded; post-merge source-branch workflow `31825258653` also succeeded.

PR #13 promotion evidence includes workflow `31826285093` attempt 2, merge to `main` as `4f8344de2dbd9963a5d4b3a96e6aeeb19d36e098`, and post-merge workflow `31837273738` success. PR #16 later synchronized active standalone docs as `d7637dfccd05e0ccba5a17a9d86d096446efef7d`.

These statements do not claim the waived browser walkthrough passed and do not claim repository promotion itself deployed a runtime host.

## Current verification gates for PR #18

Before the ChatGPT MCP milestone may be called complete, fresh evidence is required that:

- [ ] MCP initialize/tool discovery work without Authorization.
- [ ] active tools advertise `noauth`.
- [ ] OAuth/DCR/session/static external bearer runtime/config is removed.
- [ ] private MCP -> app service authentication remains fail-closed.
- [ ] `MCP_NOAUTH_WRITE_ENABLED=false` is the default and blocks writes with zero mutation.
- [ ] finite rate/in-flight/active-project limits are implemented and tested.
- [ ] active MCP approval semantics are external review acknowledgment, not authenticated human proof.
- [ ] caller cannot select actor/mode/delegation state.
- [ ] delegated E2E/delegation grants are deferred and unreachable from active MCP input.
- [ ] deterministic noauth full E2E reaches authoritative MP4 without claiming human-review proof.
- [ ] existing standalone/security/fencing/download regressions remain green.
- [ ] exact-head `Bright Profile Verification` succeeds after reset implementation.
- [ ] live ChatGPT Path A reaches `review_required` and the tested client waits for user confirmation before approval/render.
- [ ] live Path B records external review acknowledgment, renders, and retrieves a playable MP4.
- [ ] T28 records noauth write-window setup and teardown.
- [ ] project-wide Definition of Done is checked.
- [ ] final docs and PR body reflect observed exact-head truth.

## Traceability

`tasks/traceability.md` now explicitly contains two ledgers:

- Ledger A: frozen/completed T01-T16 standalone closure;
- Ledger B: open T17-T28 ChatGPT MCP noauth reset.

## Current non-goals

Unless explicitly reintroduced later, neither the completed standalone baseline nor the current noauth handoff milestone requires:

- public SaaS or multi-tenant behavior;
- commercial launch readiness;
- public Plugins Directory submission;
- publisher/business verification or public legal/listing pages;
- Codex-specific plugin completion;
- Kubernetes/multi-region infrastructure;
- a second renderer/job queue/evidence engine inside MCP;
- arbitrary automatic truth resolution for conflicting evidence;
- production OAuth/OIDC or account management in the current reset milestone;
- authenticated human-review provenance in noauth mode;
- delegated autonomous approval in the current reset milestone;
- always-on public anonymous write access.
