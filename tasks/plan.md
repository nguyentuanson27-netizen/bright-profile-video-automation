# Implementation Plan: ChatGPT MCP Temporary No-Auth Reset

**Primary spec:** `docs/specs/chatgpt-mcp-e2e-video-handoff.md`  
**Baseline status:** `docs/project-status.md`  
**Completed predecessor milestone:** standalone T01-T16 on `main`  
**Plan status:** Approved reset direction; implementation pending  
**Reset date:** 2026-08-21  
**Task range retained:** T17-T28

## Goal

Stop iterating on a home-grown OAuth/delegated-authorization implementation and reset the current ChatGPT MCP milestone around the smallest coherent contract that can be verified now:

```text
ChatGPT
  -> no-auth MCP
  -> Bright MCP tool surface
  -> private authenticated Bright Profile integration API
  -> durable generation/review/render pipeline
  -> authoritative MP4
```

The current milestone supports only `user_reviewed` approval. OAuth and `delegated_e2e` are explicitly deferred to a later trust-boundary milestone.

## Why This Reset Exists

The previous implementation combined too many security roles inside `mcp/server.mjs`: external OAuth authorization server, user-login/session system, OAuth resource server, static bearer auth, MCP server, private backend service client, and download proxy. Review repeatedly found variants of the same root problem: the runtime lacked a trustworthy source of project-specific human authorization for delegated execution, while the MCP process was also implementing its own identity system.

The reset removes those root causes instead of patching individual OAuth/delegation findings.

## Scope Decisions

### In scope

- explicit ChatGPT-facing MCP `noauth` transport;
- existing video handoff tools;
- private MCP -> Bright Profile HTTP integration protected by `BRIGHT_INTEGRATION_TOKEN`;
- imported EvidenceBundle -> durable generation;
- default stop at `review_required`;
- draft edit and `user_reviewed` approval;
- render/retry/cancel using existing durable backend semantics;
- signed authoritative MP4 delivery;
- Host/Origin, body-size, request-deadline, rate-limit, logging, SSRF, artifact, and worker-fencing controls;
- deterministic no-auth end-to-end regression;
- live ChatGPT no-auth acceptance.

### Deferred

- OAuth/OIDC external authentication;
- DCR, OAuth metadata, authorization code, PKCE, login/session, consent, access-token issuance/verification;
- `MCP_AUTH_TOKEN` static external auth;
- authenticated user identity propagation;
- `delegated_e2e` approval;
- delegation grants or any model/tool-input-based authorization surrogate.

### Unchanged

- Bright Profile standalone app remains private/loopback by default;
- worker remains unexposed;
- MCP never mounts the Bright SQLite/artifact volume;
- SQLite/job/render architecture remains canonical;
- `BRIGHT_INTEGRATION_TOKEN` remains required for the private integration boundary;
- signed MP4 capability remains required for completed output delivery.

## Target Runtime

```text
ChatGPT
   |
   | noauth MCP
   v
Bright Evidence MCP
   |-- normalize_evidence
   |-- create_video_project
   |-- get_video_project
   |-- edit_video_draft
   |-- approve_video_project      # user_reviewed only
   |-- start_video_render
   |-- retry_video_project
   `-- cancel_video_project
   |
   | BRIGHT_INTEGRATION_TOKEN
   | private network
   v
Bright Profile App
   |
   `-> durable worker -> media/TTS/render -> authoritative MP4
```

## Dependency Graph

```text
T17  Amend external trust boundary to explicit noauth
 |
 +--> T18  Simplify MCP/domain contracts to user_reviewed only
 |       |
 |       +--> T23  Remove/defer delegated authorization surface
 |
 +--> T21  Convert MCP tool transport/metadata to noauth
 |
 +--> T26  Remove OAuth/DCR deployment/config/runtime state
 |
T19/T20 existing durable import/storage work remain retained
 |
T18 + T21 + T23
 +--> T22  User-reviewed review/edit/approve path
       |
       +--> T24 existing render/retry/cancel wrappers
       +--> T25 existing signed MP4 delivery
                |
T21-T26 ------> T27 deterministic noauth E2E/security regression
                |
                +--> T28 live ChatGPT noauth acceptance + docs closure
```

## Execution Order

Do the reset in this exact order:

1. contract/spec reset;
2. external MCP `noauth` transport;
3. delete OAuth/DCR/session runtime surface;
4. simplify Compose/env/CI;
5. collapse approval to `user_reviewed` only;
6. remove delegation implementation/routes/tests;
7. rewrite deterministic E2E around the actual no-auth user-reviewed flow;
8. run full verification;
9. run live ChatGPT acceptance;
10. update status/PR claims from observed evidence only.

Do not start by repairing OAuth or adding more consent/token conditions.

## Task Details

### T17 — Temporary no-auth MCP boundary + private service auth

**Outcome:** external ChatGPT -> MCP does not require OAuth/static bearer; private MCP -> app remains authenticated.

Implementation requirements:

- `/mcp` initialization/tool discovery/legal calls work without `Authorization`;
- all active tools advertise `securitySchemes: [{type: 'noauth'}]`;
- remove external auth dispatch/fallback logic from `mcp/server.mjs`;
- preserve Host/Origin, request size, request deadline, rate limit, protocol validation, and secret-safe logging;
- keep `BRIGHT_INTEGRATION_TOKEN` for MCP -> app;
- direct integration API calls without the service token remain fail-closed with zero durable mutation.

Verification:

- noauth initialize/list/call tests;
- negative direct-backend service-auth tests;
- body/deadline/rate-limit/Host/Origin regressions remain green.

### T18 — Simplify handoff/approval contracts

**Outcome:** active public MCP contract no longer exposes auth/delegation concepts that cannot be trusted in noauth mode.

Required changes:

- `approve_video_project` input contains only project/revision/hash fields needed for user-reviewed approval;
- caller cannot choose approval mode;
- caller cannot choose approval actor;
- caller cannot provide `delegationGrant` or `delegatedContext`;
- MCP adapter sends `mode=user_reviewed` with a bounded integration-origin audit actor such as `chatgpt_mcp_noauth`;
- do not claim authenticated human identity.

Keep existing revision/hash/schema/source legality checks authoritative.

### T19 — Retain existing durable ChatGPT handoff migration

**Outcome:** keep the already-added durable integration/idempotency/origin/approval provenance storage where it remains useful.

Do not add a destructive migration just to remove deferred OAuth/delegation behavior.

Verify:

- migration from prior schema remains clean;
- imported origin/idempotency/approval provenance survives reopen;
- no OAuth client/session/token persistence is required by the new active runtime.

### T20 — Retain private backend EvidenceBundle import slice

**Outcome:** existing import path remains authoritative and service-authenticated.

Requirements remain:

- backend revalidates EvidenceBundle;
- same idempotency key returns same project;
- imported research does not call backend research provider;
- project enters `research_ready` and generation is queued;
- state survives reopen.

No external OAuth concern belongs in this task.

### T21 — Convert MCP tool surface to noauth

**Outcome:** all currently supported tools are callable without external bearer/OAuth linking.

Required changes:

- tool metadata = `noauth`;
- remove scope checks tied to OAuth access tokens;
- remove synthetic authenticated user context;
- retain bounded schemas/output normalization/backend client behavior;
- retain correlation IDs across MCP -> backend.

Checkpoint A after T17/T21:

```text
no Authorization -> initialize succeeds
no Authorization -> tools/list succeeds
no Authorization -> legal tool call reaches private backend
OAuth routes are not needed
rate/body/deadline/Host protections still work
```

### T22 — Review/edit/user-reviewed approval

**Outcome:** normal ChatGPT path stops at review and proceeds only after user confirmation.

Required flow:

```text
generation
 -> review_required
 -> get draft/evidence
 -> optional edit with revision/hash fence
 -> user confirms in ChatGPT
 -> approve_video_project
 -> backend records user_reviewed approval
```

Required negative cases:

- approval before `review_required` fails;
- stale revision/hash fails;
- invalid draft/source refs fail;
- downstream-started edit remains locked by existing invariant;
- no caller-selectable actor/mode/delegation data.

### T23 — Remove/defer delegated E2E authorization

**Outcome:** no active runtime path claims delegated authorization while external MCP is noauth.

Remove/deactivate:

- `delegated_e2e` from active MCP input contract;
- delegation grant issuance/verification from active flow;
- loopback delegation-grant route if it has no other supported caller;
- `delegationGrant`/`delegatedContext` runtime inputs;
- delegated positive-path tests;
- stale docs that claim delegated E2E is implemented/verified.

Keep DB approval columns if removing them would require unnecessary/destructive migration work.

Checkpoint B:

```text
model/tool input cannot create trusted user identity
tool input cannot choose delegated mode
default flow stops at review_required
valid user-reviewed approval works
```

### T24 — Retain render/retry/cancel wrappers

Existing MCP wrappers should remain thin adapters over backend durable semantics.

Verify:

- render-start is idempotent;
- retry only works for retryable durable failure;
- repeated retry does not duplicate replacement work;
- cancel fences stale/current owners;
- repeated cancel follows existing idempotent/no-op semantics where legal.

### T25 — Retain signed authoritative MP4 delivery

Keep current signed download capability and proxy hardening.

Verify:

- valid project/revision/artifact binding;
- expired/tampered/wrong-binding token fails closed;
- authoritative file size/hash revalidation;
- streaming/backpressure rather than full buffering;
- bounded timeout/rate limit;
- no arbitrary path/file selection.

### T26 — Remove OAuth deployment/config/runtime state

Required removals from current active deployment:

```text
MCP_AUTH_TOKEN
MCP_OAUTH_SECRET
BRIGHT_USER_AUTH_SECRET
MCP_CLIENT_STORAGE_PATH
OAuth client storage volume
OAuth/DCR/session routes/metadata
security/oauth.mjs
OAuth-specific tests
```

Keep:

```text
MCP_PUBLIC_URL
MCP_ALLOWED_HOSTS
MCP_MAX_BODY_BYTES
MCP_RATE_LIMIT_PER_MINUTE
MCP_REQUEST_TIMEOUT_MS
BRIGHT_BACKEND_URL
BRIGHT_INTEGRATION_TOKEN
```

Compose/CI must prove:

- MCP has no Bright SQLite/artifact mount;
- worker remains unexposed;
- MCP host publication remains intentionally constrained;
- private MCP -> app path works;
- no OAuth persistence volume remains.

### T27 — Deterministic noauth full E2E + adversarial regression

Replace the prior OAuth/delegated harness with the actual current product flow:

```text
start app + MCP
 -> MCP initialize without Authorization
 -> normalize_evidence
 -> create_video_project
 -> generation completes
 -> get_video_project == review_required
 -> prove no approval/render/downstream stage exists
 -> approve_video_project (user_reviewed)
 -> start_video_render
 -> media ingest
 -> TTS
 -> render
 -> completed
 -> signed MP4 download
```

Also retain representative:

- reopen/restart;
- duplicate tool calls/idempotency;
- stale edit/approval;
- direct backend unauthenticated rejection;
- retry/cancel/stale-owner fencing;
- signed-download tamper/expiry;
- source prompt-injection-looking content as inert data.

### T28 — Live ChatGPT noauth acceptance + docs/ship closure

Run against the actual deployed exact HEAD/image.

Path A:

```text
ChatGPT connects without OAuth linking
 -> normalize_evidence
 -> create_video_project
 -> review_required
 -> draft shown
 -> no approval/render before user action
```

Path B:

```text
user reviews/confirms
 -> approve_video_project
 -> user_reviewed recorded
 -> start_video_render
 -> completed
 -> MP4 downloadable/playable
```

Record:

- exact HEAD/image;
- actual tool calls;
- project IDs/status transitions;
- approval provenance;
- completed download/playback;
- no secrets or sensitive conversation content.

Only after live evidence may status docs and PR body claim the noauth flow is complete.

## Verification Checkpoints

### Checkpoint A — External transport reset

Require all:

- MCP works without Authorization;
- tools advertise `noauth`;
- OAuth/DCR/session routes are absent or unreachable as active product surface;
- body/deadline/rate-limit/Host/Origin protections remain green;
- private backend still rejects missing/wrong service credentials.

### Checkpoint B — Approval reset

Require all:

- default path stops at `review_required`;
- MCP caller cannot choose actor/mode/delegation state;
- stale revision/hash fails;
- valid user-reviewed approval works;
- no delegated positive runtime path remains.

### Checkpoint C — Runtime/output

Require all:

- render/retry/cancel preserve durable semantics;
- signed output cannot select arbitrary files;
- Compose private boundary remains intact;
- observability/correlation remains secret-safe.

### Final Checkpoint

Required evidence:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm rebuild better-sqlite3 --no-audit --no-fund
npm test
npm run lint
npm run audit:standalone
npm run build:web
npm run render:smoke
docker compose config
docker compose -f compose.mcp.yml config
```

Plus:

- exact-head `Bright Profile Verification` success;
- deterministic noauth E2E success;
- live ChatGPT noauth Path A and Path B evidence;
- project-wide Definition of Done;
- docs/PR body synchronized to observed truth.

## Security Posture During Temporary Noauth Mode

This milestone knowingly accepts that anyone who can reach the MCP endpoint can invoke its exposed tools.

Therefore:

- do not describe the external MCP surface as authenticated;
- keep network exposure intentionally narrow;
- keep rate limits and bounded request controls;
- keep private backend service authentication;
- keep idempotency/fencing to limit duplicate durable work;
- do not introduce trusted user identity/audit claims that the runtime cannot prove;
- reintroduce authenticated external access only as a separately planned trust-boundary milestone.

## Rollback

The reset should require no destructive database migration.

If live noauth exposure is unacceptable:

1. disable/withdraw public MCP ingress;
2. leave the private Bright Profile backend unchanged;
3. do **not** fall back to the partially implemented OAuth subsystem;
4. plan a separate authenticated resource-server/IdP integration milestone.

## Plan Exit Condition

This plan is complete when implementation, tests, Compose/CI, deterministic E2E, live ChatGPT acceptance, and docs all describe one coherent truth:

```text
noauth ChatGPT -> MCP
private service-authenticated MCP -> Bright Profile
user_reviewed approval only
signed authoritative MP4 delivery
OAuth + delegated_e2e deferred
```
