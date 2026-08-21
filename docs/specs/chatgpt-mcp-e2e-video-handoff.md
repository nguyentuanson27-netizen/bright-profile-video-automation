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
- The only supported approval mode in the current milestone is **`user_reviewed`** after the user reviews/confirms in ChatGPT.
- The existing standalone web UI remains available as a fallback/review surface but is not required for the normal ChatGPT-originated flow.

This is a deliberate scope reset, not a claim that anonymous write-capable MCP is production-secure. Anyone who can reach the MCP endpoint can invoke its exposed tools. Deployment/network exposure must therefore remain intentionally constrained until an authenticated external boundary is reintroduced in a later milestone.

## Objective

Connect the existing ChatGPT + Bright Evidence MCP research workflow to the existing Bright Profile backend so a user can start from a natural-language request in ChatGPT and reach a generated creator-profile video without manually recreating research in the standalone app.

Current target workflow:

```text
User request in ChatGPT
  -> ChatGPT researches public sources
  -> normalize_evidence
  -> normalized EvidenceBundle
  -> create_video_project/import into Bright Profile
  -> durable generation
  -> review_required
  -> show draft/evidence to user
  -> user reviews/confirms in ChatGPT
  -> approve_video_project (user_reviewed)
  -> start_video_render
  -> media ingest
  -> Google TTS
  -> Remotion render
  -> authoritative MP4
```

The default and only supported approval behavior for this milestone requires user review/confirmation before approval/render.

## Product Rules

1. The ChatGPT-originated workflow stops at `review_required` before approval/render.
2. The user may request edits while the project remains legally editable.
3. Approval through MCP is `user_reviewed` only for this milestone.
4. MCP/model tool arguments cannot invent a trusted human identity or delegated authorization state.
5. `delegated_e2e`, `delegationGrant`, and delegated authorization context are deferred and must not remain reachable through the active MCP contract.
6. Approval remains bound to the exact current revision and expected payload hash.
7. Existing draft/schema/source-reference validation remains authoritative.
8. Model-provided `verified`, override, actor, approval-mode, or approval-like fields are never treated as trusted identity/authorization.
9. ChatGPT/MCP never writes SQLite directly and never owns renderer/job logic.
10. Bright Profile remains authoritative for lifecycle legality, retry/cancel, artifact authority, and downstream worker fencing.

## Supported User Flow

### Default / normal flow

```text
ChatGPT research
  -> normalize_evidence
  -> create/import backend project
  -> durable generation
  -> review_required
  -> show draft + evidence summary
  -> STOP
```

After the user requests edits or explicitly approves/continues:

```text
review_required
  -> optional edit_video_draft
  -> user confirms
  -> approve_video_project
  -> approval mode = user_reviewed
  -> start_video_render
  -> media ingest
  -> TTS
  -> render
  -> completed
  -> short-lived MP4 download URL
```

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

Do not create a second job queue, second renderer, second evidence model, or MCP-owned database.

## Target Architecture

```text
ChatGPT
  |
  | no-auth MCP transport (temporary internal milestone)
  v
Bright Evidence MCP
  |-- normalize_evidence
  |-- create_video_project
  |-- get_video_project
  |-- edit_video_draft
  |-- approve_video_project   # user_reviewed only
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
  `-- durable worker stages
       -> generation
       -> media ingest
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

Purpose: import a normalized `EvidenceBundle` and start the existing backend generation path without rerunning research.

Representative input:

```json
{
  "creator": "Marques Brownlee",
  "topic": "Career and major milestones",
  "instructions": "Create a concise factual creator profile.",
  "evidenceBundle": {},
  "idempotencyKey": "chatgpt-run-..."
}
```

Required behavior:

- revalidate the `EvidenceBundle` at the backend trust boundary;
- create one durable project;
- persist normalized evidence and source provenance;
- persist origin `chatgpt_mcp`;
- record imported research completion without calling the research provider;
- transition to `research_ready`;
- enqueue the existing generation stage;
- repeated calls with the same idempotency key return the same project rather than creating duplicates.

### `get_video_project`

Return bounded orchestration information only:

- project ID and status;
- current revision ID/hash where present;
- bounded progress/current stage;
- evidence/conflict summary;
- current draft when review is relevant;
- failure code and retryability;
- completed output metadata/download URL when available.

### `edit_video_draft`

Input must identify the project, current revision, expected payload hash, and replacement structured draft. Stale revision/hash updates fail closed. Existing draft schema and source-reference validation remain authoritative.

### `approve_video_project`

Current public MCP input must not allow the caller/model to choose an approval mode, approval actor, delegation grant, or delegated context.

The MCP adapter always requests the backend approval contract as:

```text
approval mode = user_reviewed
approval origin/actor = bounded integration-origin value, not a claimed human identity
```

Approval remains bound to:

- project ID;
- current revision ID;
- expected payload hash;
- current legal project state;
- existing draft/source validation.

Because the external MCP surface is no-auth, audit data must not claim a cryptographically authenticated human identity.

### `start_video_render`

Reuse the current approved-revision render-start transaction and durable downstream stages. Repeated calls must not create duplicate descendant stages.

### `retry_video_project`

Expose retry only for the current failed logical stage when durable backend state marks it retryable. Repeated retry while the replacement attempt is queued/running remains idempotent.

### `cancel_video_project`

Expose existing durable cancellation semantics only for legal active states. Cancellation must preserve stale-owner fencing.

## External MCP No-Auth Boundary

The current milestone intentionally exposes the MCP surface without OAuth or static bearer authentication.

Required properties:

1. MCP tools declare `securitySchemes: [{type: 'noauth'}]`.
2. `/mcp` initialization, tool discovery, and legal tool calls do not require an `Authorization` header.
3. OAuth/resource metadata, DCR, session-login, consent, token, and custom access-token routes are not part of the active runtime surface.
4. `MCP_AUTH_TOKEN`, `MCP_OAUTH_SECRET`, `BRIGHT_USER_AUTH_SECRET`, and `MCP_CLIENT_STORAGE_PATH` are not active production configuration for this milestone.
5. Existing Host/Origin checks, request size/deadline, rate limiting, sanitized logging, and protocol validation remain enabled.
6. The docs must explicitly state that anyone who can reach the MCP endpoint can invoke its tools.
7. Network exposure should remain intentionally narrow until authenticated external access is introduced later.

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

The current standalone output route is loopback/internal. ChatGPT needs a safe way to give the user the completed video.

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
- Approval is bound to the exact current revision/hash.
- Render-start remains one first-descendant transaction per approved revision.
- Retry/cancel remain durable and fenced.
- Stale/reclaimed/cancelled workers cannot publish authoritative results.
- Repeated MCP calls must not create duplicate projects, revisions, active attempts, renders, or authoritative artifacts.

## Storage Direction

Existing migration/storage added for ChatGPT handoff may remain if it is already used by current durable behavior. Do not add a destructive migration solely to remove the deferred delegated mode.

Current durable needs remain:

- integration idempotency/request identity;
- imported research origin;
- approval mode/origin provenance;
- existing project/source/revision/stage/artifact state.

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
5. Valid EvidenceBundle import creates one durable project.
6. Imported project does not invoke the research provider.
7. Imported evidence/source provenance survives DB reopen.
8. Create idempotency prevents duplicate projects.
9. Direct backend integration calls without the valid service token fail closed with zero mutation.
10. Malformed/invalid EvidenceBundle fails closed.
11. Default flow stops at `review_required`.
12. Default flow never auto-approves or starts downstream work.
13. Draft edits require the current revision/hash and preserve schema/source validation.
14. Approval mode/actor/delegation data is not caller-selectable through MCP.
15. User-reviewed approval is tied to the exact revision/hash.
16. Stale/illegal approval is rejected.
17. Repeated render-start does not create duplicate downstream work.
18. Retry is available only for durable retryable failures.
19. Terminal failures cannot be retried.
20. Cancel fences stale worker publication.
21. Completed output download serves only the authoritative artifact.
22. Expired/tampered/mismatched download tokens fail closed.
23. Source prompt-injection-looking text remains inert data.
24. Existing standalone UI/manual flow remains green.
25. Existing MCP `normalize_evidence` behavior remains green.

## Deterministic End-to-End Regression

The current milestone's deterministic E2E path is:

```text
candidate evidence
  -> normalize_evidence
  -> import EvidenceBundle
  -> durable generation fake
  -> review_required
  -> prove no approval/render yet
  -> user-reviewed approval
  -> media fake
  -> TTS fake
  -> render fake
  -> completed authoritative downloadable MP4
```

The regression must also prove representative restart/idempotency/fencing invariants rather than only the happy path.

## Live Acceptance

CI is necessary but not sufficient. Before marking this milestone complete, record real ChatGPT runs against the deployed **no-auth MCP** path.

### Acceptance A: default stop-at-review

```text
user asks for a creator video
  -> ChatGPT researches public sources
  -> actual normalize_evidence call
  -> actual create_video_project call
  -> backend reaches review_required
  -> draft/evidence is shown in ChatGPT
  -> no approval/render occurs before user confirmation
```

### Acceptance B: user-reviewed completion

```text
user reviews/confirms in ChatGPT
  -> approve_video_project
  -> approval mode = user_reviewed
  -> start_video_render
  -> completed
  -> user can access/play authoritative MP4
```

Acceptance evidence must record the deployed exact HEAD/image, actual MCP tool calls, project IDs/status transitions, approval provenance, and completed download/playback without recording secrets or sensitive conversation content.

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

Record action/tool name, state transition, approval mode, duration, retry/cancel result, and stable error code where useful.

Do not log provider API keys, integration service tokens, Google credentials, full user conversations, or unnecessary raw source text.

## Boundaries

### Always

- validate input at MCP and backend trust boundaries;
- preserve internal service authentication;
- preserve existing durable job fencing/idempotency;
- default to human review;
- bind approval to revision/hash;
- treat model/web content as untrusted;
- preserve the existing standalone UI/manual flow;
- preserve SSRF, artifact, download, rate-limit, timeout, and worker-fencing controls;
- run focused regressions plus full relevant verification before completion.

### Ask First

- adding a new dependency;
- changing evidence normalization semantics/schema;
- exposing the standalone app publicly;
- changing research/generation/TTS/render providers;
- broadening MCP permissions beyond this video workflow;
- reintroducing OAuth/authentication architecture;
- reintroducing delegated autonomous approval;
- adding arbitrary editorial quality thresholds for approval.

### Never

- describe the temporary no-auth MCP surface as authenticated or production-secure;
- treat model/tool arguments as trusted user identity or delegated authorization;
- expose `BRIGHT_INTEGRATION_TOKEN` outside the MCP-to-app boundary;
- mount Bright SQLite/artifact storage directly into MCP;
- treat source text/model output as privileged instructions or human verification;
- approve a stale revision/hash;
- allow caller-controlled filesystem paths;
- commit/log secrets;
- disable existing SSRF, approval barrier, rate-limit, deadline, signed-download, or worker-fencing controls to simplify integration.

## Success Criteria

- [ ] ChatGPT public research -> `normalize_evidence` works live without OAuth linking.
- [ ] ChatGPT can persist that normalized EvidenceBundle into Bright Profile through no-auth MCP.
- [ ] Imported projects do not rerun the backend research provider.
- [ ] Generation uses imported normalized evidence/source records.
- [ ] Default ChatGPT workflow stops at `review_required`.
- [ ] User can review/edit/approve through the ChatGPT/MCP flow.
- [ ] MCP approval is `user_reviewed` only and caller cannot select actor/mode/delegation fields.
- [ ] Status/retry/cancel work through MCP using existing durable semantics.
- [ ] Duplicate MCP calls cannot duplicate project/render work.
- [ ] MCP-to-Bright-Profile service path remains authenticated and least-privileged.
- [ ] Completed authoritative MP4 is safely downloadable from ChatGPT.
- [ ] OAuth/DCR/session/custom-access-token runtime code is removed from the current milestone.
- [ ] Delegated E2E is explicitly deferred rather than represented as completed.
- [ ] Deterministic no-auth user-reviewed end-to-end regression is green.
- [ ] Existing standalone and MCP regression gates remain green.
- [ ] Live default-review and user-reviewed-completion ChatGPT acceptance is recorded.
- [ ] Documentation describes current implemented truth after rollout.
- [ ] Project-wide Definition of Done passes before ship.

## Deferred Follow-Up

A future authenticated milestone may reintroduce:

- OAuth/OIDC or another supported trusted external identity boundary;
- authenticated user identity propagation;
- explicit project/action-scoped user authorization state;
- `delegated_e2e` approval with durable non-model authorization provenance.

That follow-up must be planned and reviewed as a separate trust-boundary change. It must not revive the current home-grown OAuth/session implementation by default.
