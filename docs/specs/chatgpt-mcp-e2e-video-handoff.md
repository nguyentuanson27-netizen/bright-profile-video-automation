# Spec: ChatGPT MCP Video Handoff — Temporary No-Auth Amendment

**Status:** Approved product/spec direction; amended for temporary no-auth integration  
**Approved original direction:** 2026-08-20  
**Amended:** 2026-08-21  
**Target:** Internal Bright Profile workflow  
**Baseline:** Standalone MVP on `main` remains the execution engine

## Amendment Summary

This amendment replaces the previous external OAuth/Bearer-auth and delegated-E2E contract for the current PR milestone.

For the current milestone:

- ChatGPT -> Bright Evidence MCP uses an explicit **no-auth (`noauth`) MCP surface**.
- MCP -> Bright Profile remains a **private authenticated service boundary** using `BRIGHT_INTEGRATION_TOKEN`.
- OAuth, DCR, user-login/session handling, OAuth access-token issuance/verification, and `MCP_AUTH_TOKEN` are **deferred**.
- `delegated_e2e` approval is **deferred** because the temporary no-auth boundary has no trusted authenticated user identity or user-authorization state.
- The supported approval semantic is **external review acknowledgment** after the user-facing ChatGPT flow presents the review state and the user confirms/continues.
- The external MCP boundary cannot prove who the human user is or cryptographically prove that a human reviewed the draft; therefore no durable audit field may be described as authenticated human-review evidence.
- The existing standalone web UI remains available as a fallback/review surface but is not required for the normal ChatGPT-originated flow.

This is a deliberate scope reset, not a claim that anonymous write-capable MCP is production-secure. Anyone who can reach the MCP endpoint can invoke its exposed tools while the acceptance ingress is open. Deployment exposure therefore follows the explicit temporary guardrails below until an authenticated external boundary is reintroduced in a later milestone.

## Approval Terminology and Audit Truth

The product flow expects ChatGPT to call approval only after the draft/evidence has been shown and the user has confirmed/continued. That is a **client/product behavior requirement**, not a server-verifiable security invariant in no-auth mode.

For the current milestone:

- public MCP approval semantics are named **`external_review_acknowledged`** in docs/tests/logging language;
- the public MCP input does not expose an approval mode or actor;
- the MCP adapter uses a fixed audit origin such as `chatgpt_mcp_noauth`;
- the backend remains authoritative only for project state, current revision/hash, draft/source legality, and downstream lifecycle legality;
- the backend does **not** claim it authenticated the human reviewer;
- if the existing schema continues to persist `approval_mode='user_reviewed'` for compatibility, that value is a **legacy storage label only** for this milestone and must be interpreted/documented as external review acknowledgment, not verified human review;
- no test may treat the legacy `user_reviewed` value as proof that a human identity was authenticated or that a human definitely reviewed the draft.

A future authenticated milestone may rename/migrate the stored approval enum once a trusted user-identity/authorization boundary exists. Do not add a destructive migration solely for terminology cleanup in this temporary reset.

## Objective

Connect the existing ChatGPT + Bright Evidence MCP research workflow to the existing Bright Profile backend so a user can start from a natural-language request in ChatGPT and reach a generated creator-profile video without manually recreating research in the standalone app.

Current target workflow:

```text
User request in ChatGPT
  -> ChatGPT researches public sources
  -> normalize_evidence
  -> normalized EvidenceBundle
  -> ChatGPT constructs a complete structured draft from normalized evidence IDs
  -> create_video_project({ evidenceBundle, draft, ... })
  -> review_required
  -> show draft/evidence to user
  -> user confirms/continues in ChatGPT
  -> approve_video_project
  -> external review acknowledgment recorded
  -> start_video_render
  -> media ingest
  -> Google TTS
  -> Remotion render
  -> authoritative MP4
```

The server guarantees a stop at `review_required` before any approval/render is initiated by the backend itself. The live client acceptance must prove that the tested ChatGPT flow also waits for user confirmation before invoking approval, while docs remain explicit that the no-auth backend cannot enforce that human-intent condition against an arbitrary caller.

## Product Rules

1. The T28 supported path supplies a complete structured draft and persists it directly at `review_required` before approval/render.
2. The user may request edits while the project remains legally editable.
3. Approval through MCP is an external review acknowledgment for this milestone, not authenticated human-review proof.
4. MCP/model tool arguments cannot invent a trusted human identity or delegated authorization state.
5. `delegated_e2e`, `delegationGrant`, and delegated authorization context are deferred and must not remain reachable through the active MCP contract.
6. Approval remains bound to the exact current revision and expected payload hash.
7. Existing draft/schema/source-reference validation remains authoritative.
8. Model-provided `verified`, override, actor, approval-mode, or approval-like fields are never treated as trusted identity/authorization.
9. ChatGPT/MCP never writes SQLite directly and never owns renderer/job logic.
10. Bright Profile remains authoritative for lifecycle legality, retry/cancel, artifact authority, downstream worker fencing, and anonymous active-work admission.

## Supported User Flow

### T28 supported / keyless flow

```text
ChatGPT research
  -> normalize_evidence
  -> construct a complete structured draft using normalized evidence IDs
  -> create_video_project({ evidenceBundle, draft, ... })
  -> review_required
  -> show draft + evidence summary
  -> STOP
```

This is the required Path A contract for T28. It does not invoke the backend research or structured-generation provider and does not require `OPENAI_API_KEY`. Omitting `draft` is not an acceptable fallback during T28.

After the user requests edits or explicitly confirms/continues in the tested ChatGPT flow:

```text
review_required
  -> optional edit_video_draft
  -> user confirms/continues in ChatGPT
  -> approve_video_project
  -> external review acknowledgment
  -> start_video_render
  -> media ingest
  -> TTS
  -> render
  -> completed
  -> short-lived MP4 download URL
```

The backend cannot distinguish an honest ChatGPT confirmation flow from an arbitrary anonymous caller invoking `approve_video_project`; this limitation is accepted only for the temporary no-auth milestone and is mitigated by the deployment guardrails below.

### Deferred explicit autonomous flow

The previous flow using `approval(mode=delegated_e2e)` is **not part of the current milestone**.

It may return only after a later milestone introduces a trusted external user-authentication/authorization boundary capable of producing server-verifiable user authorization state. That future work must not reuse model/tool arguments as authorization evidence.

## Existing Baseline to Reuse

The implementation must reuse the current standalone MVP rather than create a parallel pipeline:

- durable SQLite project/source/revision/stage/attempt/artifact state;
- lease renewal, retry, cancel, reclaim, and claim-token fencing;
- existing evidence schemas and deterministic normalizer;
- structured generation and draft validation;
- review/edit and immutable revision approval;
- approved media ingest through the SSRF-safe fetch boundary;
- Google Cloud TTS;
- Remotion rendering;
- authoritative output validation and download;
- existing app + worker separation and named data volume;
- existing test, lint, audit, build, health, render-smoke, and Compose gates.

Do not create a second job queue, second renderer, second evidence model, MCP-owned database, or process-local substitute for durable capacity admission.

## Target Architecture

```text
ChatGPT
  |
  | no-auth MCP transport (temporary acceptance/test milestone)
  v
Bright Evidence MCP
  |-- normalize_evidence
  |-- create_video_project
  |-- get_video_project
  |-- edit_video_draft
  |-- approve_video_project   # external review acknowledgment
  |-- start_video_render
  |-- retry_video_project
  `-- cancel_video_project
  |
  | private authenticated service call
  | BRIGHT_INTEGRATION_TOKEN
  v
Bright Profile integration API
  |
  |-- domain/services
  |-- SQLite repositories
  |-- durable anonymous-capacity admission
  `-- durable worker stages
       -> generation       # compatibility path only when draft is omitted
       -> media ingest     # T28 resumes here after review acknowledgment
       -> TTS
       -> render
       -> MP4
```

The MCP container must not mount the Bright Profile SQLite database or artifact volume.

## MCP Tool Surface

All tools in the current ChatGPT-facing surface use MCP `noauth` security metadata. There is no OAuth linking flow in this milestone.

### `normalize_evidence`

Keep the existing read-only deterministic tool backward-compatible.

### `create_video_project`

Purpose: import a normalized `EvidenceBundle` and preserve a ChatGPT-created structured draft for review. The API also retains an omitted-draft backend-generation path for standalone/backward compatibility.

Representative input:

```json
{
  "creator": "Marques Brownlee",
  "topic": "Career and major milestones",
  "instructions": "Create a concise factual creator profile.",
  "evidenceBundle": {},
  "draft": {},
  "idempotencyKey": "chatgpt-run-..."
}
```

Required behavior:

- revalidate the `EvidenceBundle` at the backend trust boundary;
- apply idempotency before allocating new active capacity when the same request already exists;
- for a new project, perform active-capacity admission in the same authoritative database transaction that creates the project/enqueues its first active work;
- persist normalized evidence and source provenance;
- persist origin `chatgpt_mcp`;
- record imported research completion without calling the research provider;
- when `draft` is omitted, transition to `research_ready` and enqueue the existing generation stage;
- when `draft` is supplied, require the complete existing draft schema, require its `sourceIds` to reference normalized evidence IDs, replace those references with application-owned source IDs, force every claim to `verified=false`, and persist the revision directly at `review_required` with no generation stage;
- reject caller-managed `scene.mediaUrl` values and never treat model-supplied verification fields as human approval;
- repeated calls with the same idempotency key return the same project rather than creating duplicates.

Milestone routing contract:

- **T28 supported path:** `draft` is operationally required even though it remains optional in the public schema for compatibility. ChatGPT must construct and submit the complete draft; this path is keyless and goes directly to `review_required`.
- **Compatibility path:** when `draft` is omitted, Bright Profile queues backend structured generation. That worker stage may require its configured OpenAI provider credentials, including `OPENAI_API_KEY`, and is not a T28 Path A/B acceptance path.

### `get_video_project`

Return bounded orchestration information only:

- project ID and status;
- current revision ID/hash where present;
- bounded progress/current stage;
- evidence/conflict summary;
- current draft when review is relevant;
- failure code and retryability;
- completed output metadata/download URL when available.

Because this data is callable without external authentication while MCP ingress is open, the external ingress itself is temporary and must be withdrawn after T28 acceptance.

### `edit_video_draft`

Input must identify the project, current revision, expected payload hash, and replacement structured draft. Stale revision/hash updates fail closed. Existing draft schema and source-reference validation remain authoritative.

### `approve_video_project`

Current public MCP input must not allow the caller/model to choose an approval mode, approval actor, delegation grant, or delegated context.

The MCP adapter requests approval with:

```text
approval semantic = external_review_acknowledged
approval origin/actor = chatgpt_mcp_noauth (or equivalent bounded integration-origin value)
```

If storage compatibility requires the existing `approval_mode='user_reviewed'`, keep that as an internal legacy representation only and document/map it explicitly to `external_review_acknowledged` at the MCP/integration boundary.

Approval remains bound to:

- project ID;
- current revision ID;
- expected payload hash;
- current legal project state;
- existing draft/source validation.

Because the external MCP surface is no-auth, audit data must not claim a cryptographically authenticated human identity or a server-proven human review event.

### `start_video_render`

Reuse the current approved-revision render-start transaction and durable downstream stages. Repeated calls must not create duplicate descendant stages.

### `retry_video_project`

Expose retry only for the current failed logical stage when durable backend state marks it retryable. If retry/reactivation changes a ChatGPT-origin project from terminal/inactive to non-terminal/active, the backend must acquire an active-project slot **transactionally in the same durable operation** that queues the replacement work. If capacity is full, return `NOAUTH_CAPACITY_REACHED` with zero replacement attempt/job/state mutation. Repeated retry while replacement work is already queued/running remains idempotent.

### `cancel_video_project`

Expose existing durable cancellation semantics only for legal active states. Cancellation must preserve stale-owner fencing.

## External MCP No-Auth Boundary

The current milestone intentionally exposes the MCP surface without OAuth or static bearer authentication.

Required properties:

1. MCP tools declare `securitySchemes: [{type: 'noauth'}]`.
2. `/mcp` initialization, tool discovery, and legal tool calls do not require an `Authorization` header.
3. OAuth/resource metadata, DCR, session-login, consent, token, and custom access-token routes are not part of the active runtime surface.
4. `MCP_AUTH_TOKEN`, `MCP_OAUTH_SECRET`, `BRIGHT_USER_AUTH_SECRET`, and `MCP_CLIENT_STORAGE_PATH` are not active configuration for this milestone.
5. Existing Host/Origin checks, request size/deadline, rate limiting, sanitized logging, and protocol validation remain enabled.
6. The docs explicitly state that anyone who can reach the MCP endpoint can invoke exposed tools while the acceptance ingress is open.
7. No-auth access is limited to an explicitly operator-enabled acceptance/test window; the remote ingress is not an always-on production posture.

## Temporary No-Auth Deployment Guardrails

These controls are part of the current milestone contract, not optional operational advice.

### Kill switch

- Add `MCP_NOAUTH_WRITE_ENABLED` with a default of `false`.
- When false, write/cost-bearing tools (`create_video_project`, `edit_video_draft`, `approve_video_project`, `start_video_render`, `retry_video_project`, `cancel_video_project`) fail before backend side effects with stable error `NOAUTH_WRITE_DISABLED`.
- Read-only health/discovery/status/normalization behavior may remain available **only while the temporary external MCP ingress is intentionally open**.
- Live T28 acceptance may set `MCP_NOAUTH_WRITE_ENABLED=true` only for the explicit acceptance window.
- T28 teardown requires **both** restoring `MCP_NOAUTH_WRITE_ENABLED=false` **and** withdrawing the external MCP ingress/reverse-proxy route. Disabling writes alone is not sufficient because no-auth status/draft/output metadata remains readable while ingress is open.
- Continued temporary testing after T28 requires opening a new explicitly approved bounded window; it must not be achieved by leaving the acceptance ingress up after closure.

### Bounded anonymous capacity

Default temporary limits:

```text
MCP_RATE_LIMIT_PER_MINUTE=20
MCP_MAX_INFLIGHT_WRITE_REQUESTS=2
MCP_MAX_ACTIVE_PROJECTS=3
```

`MCP_MAX_ACTIVE_PROJECTS` is a **durable global invariant**, not a best-effort MCP-process counter.

Requirements:

- these limits are configurable but must never default to unlimited in no-auth mode;
- an active project is a non-terminal `origin=chatgpt_mcp` project that can own/queue active durable work;
- authoritative capacity admission is enforced by Bright Profile in the same SQLite transaction that would create or reactivate active durable work;
- admission applies to a new create, retry/requeue/reactivation of a failed/inactive ChatGPT-origin project, and any future transition that changes such a project from terminal/inactive to non-terminal/active;
- idempotent replay that merely returns an already-existing project/result does not consume a second slot and must not fail solely because the cap is now full;
- a process-local precheck in MCP may be used only as an optimization and is never the authority;
- concurrent callers/processes/replicas must serialize through the durable admission boundary so committed state never exceeds `MCP_MAX_ACTIVE_PROJECTS`;
- when capacity is unavailable, return stable `NOAUTH_CAPACITY_REACHED` and commit no new project, replacement attempt/job, or reactivation state;
- the in-flight write cap rejects/queues excess anonymous write requests without creating backend side effects;
- existing per-project idempotency and render-start uniqueness remain mandatory;
- CI must cover kill switch, rate limit, in-flight cap, active-cap create, active-cap retry/reactivation, and a concurrent admission race proving the committed active count never exceeds the configured cap.

### Exposure window

- The app/browser API remains private/loopback-oriented and is never exposed merely to support ChatGPT.
- Remote ChatGPT access is provided only through the intended HTTPS MCP ingress/reverse-proxy boundary.
- The no-auth MCP surface is a single-operator/internal acceptance/test posture, not a public multi-user service.
- T28 evidence records when the external MCP ingress and no-auth write window were enabled.
- T28 closure requires the write flag restored to false **and** the external MCP ingress withdrawn, with both teardown times recorded.

## Private MCP-to-Bright-Profile Authentication

The internal service boundary remains authenticated and fail-closed.

Required properties:

1. MCP-to-Bright-Profile uses `BRIGHT_INTEGRATION_TOKEN`.
2. The service token is distinct from any future external user/auth credential.
3. The service token is never exposed to the model, browser, logs, or tool results.
4. Missing/blank internal service configuration must fail before side-effecting backend work.
5. Direct unauthenticated or incorrectly authenticated calls to `/api/integrations/chatgpt/*` fail with zero durable mutation.
6. MCP and app communicate over the intended private/internal network path.
7. The Bright Profile browser/API loopback boundary is not simply made public to satisfy MCP connectivity.

## Secure MP4 Delivery

The current standalone output route is loopback/internal. ChatGPT needs a safe way to give the user the completed video during the bounded acceptance window.

Target:

```text
completed authoritative artifact
  -> short-lived signed download token
  -> HTTPS download endpoint at MCP/integration boundary
  -> stream authoritative MP4 from internal app
```

Requirements:

- opaque/signed token;
- bound to project + approved revision + authoritative output artifact;
- short expiry, target no more than 15 minutes;
- no caller-controlled filesystem path or arbitrary artifact selector;
- authoritative artifact identity/size/hash revalidated before serving;
- stream rather than buffer the full MP4 in MCP memory;
- preserve timeout/rate-limit/backpressure controls;
- expired/tampered/mismatched tokens fail closed;
- no directory listing or arbitrary file retrieval.

## Idempotency and Concurrency

Remote tool calls may be retried. The implementation must preserve existing durable invariants.

- `create_video_project` requires an idempotency key.
- The same idempotency key maps to one project/request result.
- New active work and reactivated work share the same durable active-project admission invariant.
- Approval is bound to the exact current revision/hash.
- Render-start remains one first-descendant transaction per approved revision.
- Retry/cancel remain durable and fenced.
- Stale/reclaimed/cancelled workers cannot publish authoritative results.
- Repeated MCP calls must not create duplicate projects, revisions, active attempts, renders, or authoritative artifacts.

## Storage Direction

Existing migration/storage added for ChatGPT handoff may remain if it is already used by current durable behavior. Do not add a destructive migration solely to remove deferred delegated mode or rename the legacy approval enum.

Current durable needs remain:

- integration idempotency/request identity;
- imported research origin;
- approval origin/provenance;
- existing project/source/revision/stage/artifact state;
- a transactional query/update boundary capable of enforcing global ChatGPT-origin active-work admission.

If `approval_mode='user_reviewed'` remains in the current schema, document it as the legacy persistence value for external review acknowledgment during no-auth mode.

Do not persist external auth/OAuth session/client state in this milestone.

## Project Structure Direction

Expected active surfaces after the reset:

```text
mcp/
  server.mjs
  schemas/

app/
  http/
    integrations.mjs

domain/
  schemas.mjs
  errors.mjs

security/
  integration-auth.mjs
  download-token.mjs

storage/
  migrations/
    003_chatgpt_handoff.sql

tests/
  unit/
  integration/

compose.yml
compose.mcp.yml
```

Expected removals from the active milestone:

```text
security/oauth.mjs
security/delegation-grant.mjs
OAuth/DCR/session tests
delegated-E2E positive-path tests
```

Keep individual implementation tasks to small vertical slices; do not refactor unrelated standalone surfaces.

## Testing Strategy

Use the existing `node:test` suite plus focused integration/runtime coverage. New behavior must be introduced with RED -> GREEN regression evidence.

Required coverage includes:

1. MCP initialize/tool discovery succeeds without Authorization.
2. Tool metadata declares `noauth`.
3. OAuth/DCR/session/token paths are absent from the active runtime surface.
4. Existing Host/Origin/body/deadline/rate-limit protections remain enforced.
5. `MCP_NOAUTH_WRITE_ENABLED=false` blocks every write/cost-bearing tool before side effects.
6. Configured global rate and in-flight write caps are enforced.
7. New create admission enforces `MCP_MAX_ACTIVE_PROJECTS` transactionally.
8. Retry/reactivation admission enforces the same active-project cap transactionally.
9. Concurrent create/retry admission cannot commit more active ChatGPT-origin projects than the configured cap.
10. Capacity rejection returns `NOAUTH_CAPACITY_REACHED` with zero new project/job/attempt/reactivation mutation.
11. Valid EvidenceBundle import creates one durable project when writes are enabled and capacity exists.
12. Imported project does not invoke the research provider.
13. Imported evidence/source provenance survives DB reopen.
14. Create idempotency prevents duplicate projects and replay does not consume a second capacity slot.
15. Direct backend integration calls without the valid service token fail closed with zero mutation.
16. Malformed/invalid EvidenceBundle fails closed.
17. Supplied-draft import reaches `review_required` without a generation job and does not auto-approve/start downstream work.
18. Omitted-draft compatibility import reaches `research_ready`, queues backend generation, and is not treated as the keyless T28 path.
19. Draft edits require the current revision/hash and preserve schema/source validation.
20. Approval mode/actor/delegation data is not caller-selectable through MCP.
21. Approval is recorded as external review acknowledgment; any legacy `user_reviewed` storage value is not asserted as authenticated human proof.
22. Stale/illegal approval is rejected.
23. Repeated render-start does not create duplicate downstream work.
24. Retry is available only for durable retryable failures and obeys capacity admission when it reactivates work.
25. Terminal failures cannot be retried.
26. Cancel fences stale worker publication.
27. Completed output download serves only the authoritative artifact.
28. Expired/tampered/mismatched download tokens fail closed.
29. Source prompt-injection-looking text remains inert data.
30. Existing standalone UI/manual flow remains green.
31. Existing MCP `normalize_evidence` behavior remains green.
32. T28 teardown evidence proves both writes disabled and external MCP ingress withdrawn.

## Deterministic End-to-End Regression

Automated verification deliberately covers two distinct paths.

The supported T28 handoff contract regression is:

```text
candidate evidence
  -> normalize_evidence
  -> construct complete structured draft
  -> import EvidenceBundle + draft
  -> review_required with no generation job
  -> prove imported source references are application-owned
  -> prove no backend auto-approval/render yet
```

The retained compatibility/lifecycle E2E is:

```text
candidate evidence
  -> normalize_evidence
  -> import EvidenceBundle without draft
  -> durable generation fake
  -> review_required
  -> prove no backend auto-approval/render yet
  -> test harness explicitly invokes approve_video_project
  -> external review acknowledgment recorded
  -> media fake
  -> TTS fake
  -> render fake
  -> completed authoritative downloadable MP4
```

Together these regressions prove the supplied-draft handoff and the retained backend-generation lifecycle. The compatibility E2E is not the T28 client sequence. Neither automated test proves a real human reviewed the draft; human/client confirmation behavior is verified only by T28 live acceptance.

The regression also proves representative restart/idempotency/fencing, kill-switch, and transactional no-auth capacity invariants rather than only the happy path.

## Live Acceptance

CI is necessary but not sufficient. Before marking this milestone complete, record real ChatGPT runs against the deployed **no-auth MCP** path during a bounded write-enabled acceptance window.

### Acceptance A: default stop-at-review

```text
user asks for a creator video
  -> ChatGPT researches public sources
  -> actual normalize_evidence call
  -> ChatGPT constructs a complete structured draft using normalized evidence IDs
  -> actual create_video_project call containing EvidenceBundle + draft
  -> backend reaches review_required
  -> draft/evidence is shown in ChatGPT
  -> ChatGPT does not invoke approval/render before user confirmation
```

The acceptance record must prove that the `create_video_project` input contained a complete `draft`. If the client omits it and enters backend generation, stop and classify Path A as failed/blocked rather than relying on provider credentials. This proves the tested ChatGPT client behavior, not an enforceable server guarantee against arbitrary anonymous callers.

### Acceptance B: review-acknowledged completion

```text
user explicitly confirms/continues in ChatGPT
  -> actual approve_video_project call
  -> external review acknowledgment recorded
  -> actual start_video_render call
  -> completed
  -> user can access/play authoritative MP4
```

### Mandatory acceptance teardown

After Path B evidence is captured:

1. restore `MCP_NOAUTH_WRITE_ENABLED=false`;
2. withdraw/disable the external HTTPS MCP ingress/reverse-proxy route;
3. record both teardown timestamps and verify the remote MCP endpoint is no longer externally reachable;
4. only then may T28 be marked complete.

Leaving the external no-auth ingress reachable with writes disabled is **not** an acceptable closed state because `get_video_project` and completed-output metadata remain anonymous while ingress is open.

Acceptance evidence must record the deployed exact HEAD/image, actual MCP tool calls, project IDs/status transitions, bounded approval provenance, completed download/playback, configured capacity values, ingress/write-window enable time, and both teardown events without recording secrets or sensitive conversation content.

## Observability

A ChatGPT-originated project must be traceable through bounded structured identifiers:

```text
MCP request/correlation ID
  -> integration/idempotency key
  -> project ID
  -> revision ID/hash
  -> durable stage/attempt
  -> authoritative artifact
```

Record action/tool name, state transition, approval semantic/origin, capacity admission/rejection, duration, retry/cancel result, and stable error code where useful.

Do not log provider API keys, integration service tokens, Google credentials, full user conversations, or unnecessary raw source text.

## Boundaries

### Always

- validate input at MCP and backend trust boundaries;
- preserve internal service authentication;
- preserve existing durable job fencing/idempotency;
- enforce active-project admission transactionally at the authoritative durable boundary;
- stop backend-driven flow at review before approval/render;
- do not represent external review acknowledgment as authenticated human proof;
- bind approval to revision/hash;
- treat model/web content as untrusted;
- preserve the existing standalone UI/manual flow;
- preserve SSRF, artifact, download, rate-limit, timeout, capacity, kill-switch, and worker-fencing controls;
- withdraw external MCP ingress after T28 acceptance;
- run focused regressions plus full relevant verification before completion.

### Ask First

- adding a new dependency;
- changing evidence normalization semantics/schema;
- exposing the standalone app publicly;
- changing research/generation/TTS/render providers;
- broadening MCP permissions beyond this video workflow;
- reintroducing OAuth/authentication architecture;
- reintroducing delegated autonomous approval;
- opening a new no-auth acceptance/test window after T28;
- raising/removing anonymous capacity limits;
- adding arbitrary editorial quality thresholds for approval.

### Never

- describe the temporary no-auth MCP surface as authenticated or production-secure;
- describe the no-auth approval record as authenticated human-review evidence;
- treat model/tool arguments as trusted user identity or delegated authorization;
- expose `BRIGHT_INTEGRATION_TOKEN` outside the MCP-to-app boundary;
- mount Bright SQLite/artifact storage directly into MCP;
- use only process-local counters as the active-project capacity authority;
- treat source text/model output as privileged instructions or human verification;
- approve a stale revision/hash;
- allow caller-controlled filesystem paths;
- commit/log secrets;
- leave the external no-auth MCP ingress reachable after T28 closure;
- disable existing SSRF, approval-state barrier, rate-limit, deadline, capacity, kill-switch, signed-download, or worker-fencing controls to simplify integration.

## Success Criteria

- [ ] ChatGPT public research -> `normalize_evidence` works live without OAuth linking.
- [ ] ChatGPT can persist that normalized EvidenceBundle into Bright Profile through no-auth MCP during an explicit write-enabled window.
- [ ] Imported projects do not rerun the backend research provider.
- [ ] ChatGPT constructs and submits a complete structured draft whose provenance uses normalized evidence IDs.
- [ ] The T28 supplied-draft import reaches `review_required` without backend generation or `OPENAI_API_KEY`.
- [ ] The retained draft-omitted compatibility path is documented separately and may require the backend OpenAI generation provider.
- [ ] The supplied-draft flow stops at `review_required` and does not auto-approve/render.
- [ ] Live ChatGPT acceptance shows the tested client waits for user confirmation before invoking approval.
- [ ] Approval is represented as external review acknowledgment, not authenticated human proof.
- [ ] Caller cannot select actor/mode/delegation fields.
- [ ] Status/retry/cancel work through MCP using existing durable semantics.
- [ ] Duplicate MCP calls cannot duplicate project/render work.
- [ ] MCP-to-Bright-Profile service path remains authenticated and least-privileged.
- [ ] No-auth write kill switch, rate limit, and in-flight write cap are enforced.
- [ ] `MCP_MAX_ACTIVE_PROJECTS` is enforced transactionally for create and retry/reactivation; concurrent admission cannot exceed the configured cap.
- [ ] Completed authoritative MP4 is safely downloadable from ChatGPT during the acceptance window.
- [ ] OAuth/DCR/session/custom-access-token runtime code is removed from the current milestone.
- [ ] Delegated E2E is explicitly deferred rather than represented as completed.
- [ ] Deterministic no-auth review-acknowledged end-to-end regression is green.
- [ ] Existing standalone and MCP regression gates remain green.
- [ ] Live stop-at-review and review-acknowledged-completion ChatGPT acceptance is recorded.
- [ ] After acceptance, writes are disabled **and** external MCP ingress is withdrawn; remote anonymous reads are not left reachable.
- [ ] Documentation describes current implemented truth after rollout.
- [ ] Project-wide Definition of Done passes before ship.

## Deferred Follow-Up

A future authenticated milestone may reintroduce:

- OAuth/OIDC or another supported trusted external identity boundary;
- authenticated user identity propagation;
- explicit project/action-scoped user authorization state;
- `delegated_e2e` approval with durable non-model authorization provenance;
- a stored approval enum that truthfully represents authenticated human review if product requirements need that distinction.

That follow-up must be planned and reviewed as a separate trust-boundary change. It must not revive the current home-grown OAuth/session implementation by default.
