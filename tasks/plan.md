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

The current milestone does **not** claim authenticated human review. Its approval semantic is `external_review_acknowledged`: the tested ChatGPT flow should invoke approval only after the user confirms/continues, while the no-auth backend records only that the external flow acknowledged review. OAuth and `delegated_e2e` are explicitly deferred to a later trust-boundary milestone.

If the existing database continues to persist `approval_mode='user_reviewed'`, that value is treated as a legacy storage label for `external_review_acknowledged` during this milestone, not as proof of authenticated human review.

## Why This Reset Exists

The previous implementation combined too many security roles inside `mcp/server.mjs`: external OAuth authorization server, user-login/session system, OAuth resource server, static bearer auth, MCP server, private backend service client, and download proxy. Review repeatedly found variants of the same root problem: the runtime lacked a trustworthy source of project-specific human authorization for delegated execution, while the MCP process was also implementing its own identity system.

The no-auth reset removes those root causes instead of patching individual OAuth/delegation findings. Because anonymous writes are deliberately accepted for a temporary acceptance/test window, the reset also requires explicit operational guardrails rather than vague “narrow exposure” language.

## Scope Decisions

### In scope

- explicit ChatGPT-facing MCP `noauth` transport;
- existing video handoff tools;
- private MCP -> Bright Profile HTTP integration protected by `BRIGHT_INTEGRATION_TOKEN`;
- imported EvidenceBundle -> durable generation;
- backend stop at `review_required`;
- draft edit and external review acknowledgment approval;
- render/retry/cancel using existing durable backend semantics;
- signed authoritative MP4 delivery;
- Host/Origin, body-size, request-deadline, rate-limit, logging, SSRF, artifact, and worker-fencing controls;
- a default-off no-auth write kill switch;
- bounded anonymous request/concurrency/project capacity;
- deterministic no-auth end-to-end regression;
- live ChatGPT no-auth acceptance in a bounded write-enabled window.

### Deferred

- OAuth/OIDC external authentication;
- DCR, OAuth metadata, authorization code, PKCE, login/session, consent, access-token issuance/verification;
- `MCP_AUTH_TOKEN` static external auth;
- authenticated user identity propagation;
- server-verifiable human-review provenance;
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
   |-- approve_video_project      # external review acknowledgment
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

## Temporary No-Auth Deployment Contract

The following controls are implementation requirements for T17/T26, not optional deployment notes.

```text
MCP_NOAUTH_WRITE_ENABLED=false
MCP_RATE_LIMIT_PER_MINUTE=20
MCP_MAX_INFLIGHT_WRITE_REQUESTS=2
MCP_MAX_ACTIVE_PROJECTS=3
```

Semantics:

- writes are **off by default**;
- when `MCP_NOAUTH_WRITE_ENABLED=false`, all write/cost-bearing MCP tools fail before backend side effects with `NOAUTH_WRITE_DISABLED`;
- `MCP_MAX_INFLIGHT_WRITE_REQUESTS` caps simultaneous anonymous write work;
- `MCP_MAX_ACTIVE_PROJECTS` caps non-terminal `origin=chatgpt_mcp` projects; excess create attempts fail with `NOAUTH_CAPACITY_REACHED`;
- no limit may default to unlimited in no-auth mode;
- T28 may enable writes only for the explicit acceptance/test window;
- after live acceptance, writes must be disabled and/or remote ingress withdrawn unless continued temporary testing is explicitly approved;
- the Bright Profile app itself remains private; remote access is through the intended HTTPS MCP ingress only.

## Approval Truth Contract

The plan separates product/client behavior from backend security guarantees:

- **Client behavior to verify live:** ChatGPT shows the review state and waits for user confirmation before invoking `approve_video_project`.
- **Backend guarantee:** the backend itself does not auto-approve at `review_required`; approval is revision/hash/state/schema fenced.
- **Backend limitation in noauth mode:** an arbitrary anonymous caller can invoke approval when writes are enabled, so the backend cannot prove a real human reviewed the draft.
- **Audit semantics:** record `external_review_acknowledged` at the integration/docs level and a bounded actor/origin such as `chatgpt_mcp_noauth`; never claim an authenticated human identity.
- **Storage compatibility:** if schema v3 retains `approval_mode='user_reviewed'`, map/document it as the legacy persistence value for the above external acknowledgment only.

## Dependency Graph

```text
T17  Amend external trust boundary to explicit noauth + bounded write controls
 |
 +--> T18  Simplify MCP/domain contracts to external review acknowledgment
 |       |
 |       +--> T23  Remove/defer delegated authorization surface
 |
 +--> T21  Convert MCP tool transport/metadata to noauth
 |
 +--> T26  Remove OAuth/DCR state + add noauth deployment guardrails
 |
T19/T20 existing durable import/storage work remain retained
 |
T18 + T21 + T23
 +--> T22  Review/edit/review-acknowledged approval path
       |
       +--> T24 existing render/retry/cancel wrappers
       +--> T25 existing signed MP4 delivery
                |
T21-T26 ------> T27 deterministic noauth E2E/security regression
                |
                +--> T28 live ChatGPT bounded noauth acceptance + docs closure
```

## Execution Order

Do the reset in this exact order:

1. contract/spec reset;
2. external MCP `noauth` transport + default-off write kill switch;
3. delete OAuth/DCR/session runtime surface;
4. simplify Compose/env/CI and add bounded no-auth capacity controls;
5. collapse approval to external review acknowledgment semantics;
6. remove delegation implementation/routes/tests;
7. rewrite deterministic E2E around the actual no-auth review-acknowledged flow;
8. run full verification;
9. run live ChatGPT acceptance in a bounded write-enabled window;
10. disable writes/withdraw ingress and update status/PR claims from observed evidence only.

Do not start by repairing OAuth or adding more consent/token conditions.

## Task Details

### T17 — Temporary no-auth MCP boundary + private service auth + kill switch

**Outcome:** external ChatGPT -> MCP does not require OAuth/static bearer; private MCP -> app remains authenticated; anonymous writes are default-off and bounded.

Implementation requirements:

- `/mcp` initialization/tool discovery/legal calls work without `Authorization`;
- all active tools advertise `securitySchemes: [{type: 'noauth'}]`;
- remove external auth dispatch/fallback logic from `mcp/server.mjs`;
- preserve Host/Origin, request size, request deadline, rate limit, protocol validation, and secret-safe logging;
- keep `BRIGHT_INTEGRATION_TOKEN` for MCP -> app;
- direct integration API calls without the service token remain fail-closed with zero durable mutation;
- implement `MCP_NOAUTH_WRITE_ENABLED=false` by default;
- disabled writes fail with `NOAUTH_WRITE_DISABLED` before backend side effects;
- implement finite in-flight write and active-project caps.

Verification:

- noauth initialize/list/call tests;
- kill-switch negative tests with zero mutation;
- in-flight/active-project capacity tests;
- negative direct-backend service-auth tests;
- body/deadline/rate-limit/Host/Origin regressions remain green.

### T18 — Simplify handoff/approval contracts

**Outcome:** active public MCP contract no longer exposes auth/delegation concepts or falsely claims authenticated human review.

Required changes:

- `approve_video_project` input contains only project/revision/hash fields needed for approval;
- caller cannot choose approval mode;
- caller cannot choose approval actor;
- caller cannot provide `delegationGrant` or `delegatedContext`;
- MCP adapter records external review acknowledgment with bounded actor/origin `chatgpt_mcp_noauth` or equivalent;
- if backend storage still requires `mode=user_reviewed`, treat it as a compatibility mapping only;
- API/tool responses, tests, docs, and logs must not describe that legacy value as authenticated human proof.

Keep existing revision/hash/schema/source legality checks authoritative.

### T19 — Retain existing durable ChatGPT handoff migration

**Outcome:** keep already-added durable integration/idempotency/origin/approval provenance storage where useful.

Do not add a destructive migration merely to remove deferred OAuth/delegation behavior or rename the compatibility enum.

Verify:

- migration from prior schema remains clean;
- imported origin/idempotency/approval provenance survives reopen;
- no OAuth client/session/token persistence is required by the new active runtime;
- compatibility mapping for legacy `user_reviewed` is documented if retained.

### T20 — Retain private backend EvidenceBundle import slice

**Outcome:** existing import path remains authoritative and service-authenticated.

Requirements remain:

- backend revalidates EvidenceBundle;
- same idempotency key returns same project;
- imported research does not call backend research provider;
- project enters `research_ready` and generation is queued;
- state survives reopen;
- active-project capacity is checked before creating a new no-auth-origin project when temporary writes are enabled.

No external OAuth concern belongs in this task.

### T21 — Convert MCP tool surface to noauth

**Outcome:** all currently supported tools are callable without external bearer/OAuth linking, subject to the default-off write gate for mutating tools.

Required changes:

- tool metadata = `noauth`;
- remove scope checks tied to OAuth access tokens;
- remove synthetic authenticated user context;
- retain bounded schemas/output normalization/backend client behavior;
- retain correlation IDs across MCP -> backend;
- apply write gate and in-flight capacity before write-side backend dispatch.

Checkpoint A after T17/T21:

```text
no Authorization -> initialize succeeds
no Authorization -> tools/list succeeds
writes disabled -> write tool fails before backend mutation
writes enabled -> legal write tool reaches private backend
OAuth routes are not needed
rate/body/deadline/Host/capacity protections still work
```

### T22 — Review/edit/external-review-acknowledgment path

**Outcome:** backend stops at review; the live ChatGPT path proceeds only after user confirmation, while server/audit semantics remain truthful about the no-auth limitation.

Required flow:

```text
generation
 -> review_required
 -> get draft/evidence
 -> optional edit with revision/hash fence
 -> user confirms in ChatGPT (live client behavior)
 -> approve_video_project
 -> external review acknowledgment recorded
```

Required negative cases:

- backend does not auto-approve at `review_required`;
- approval before `review_required` fails;
- stale revision/hash fails;
- invalid draft/source refs fail;
- downstream-started edit remains locked by existing invariant;
- no caller-selectable actor/mode/delegation data;
- no response/log/test claims authenticated human review.

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
backend stops at review_required
valid external review acknowledgment works when writes are enabled
```

### T24 — Retain render/retry/cancel wrappers

Existing MCP wrappers should remain thin adapters over backend durable semantics.

Verify:

- all write wrappers honor the no-auth write kill switch and in-flight capacity gate;
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

### T26 — Remove OAuth deployment/config/runtime state and add explicit noauth guardrails

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

Keep/add:

```text
MCP_PUBLIC_URL
MCP_ALLOWED_HOSTS
MCP_MAX_BODY_BYTES
MCP_REQUEST_TIMEOUT_MS
BRIGHT_BACKEND_URL
BRIGHT_INTEGRATION_TOKEN
MCP_NOAUTH_WRITE_ENABLED=false
MCP_RATE_LIMIT_PER_MINUTE=20
MCP_MAX_INFLIGHT_WRITE_REQUESTS=2
MCP_MAX_ACTIVE_PROJECTS=3
```

Compose/CI must prove:

- MCP has no Bright SQLite/artifact mount;
- worker remains unexposed;
- app remains private;
- MCP remote access uses intended HTTPS ingress/reverse proxy rather than exposing the app;
- no-auth writes are disabled by default;
- rate/concurrency/active-project limits are finite and enforced;
- private MCP -> app path works;
- no OAuth persistence volume remains.

### T27 — Deterministic noauth full E2E + adversarial regression

Replace the prior OAuth/delegated harness with the actual current server/tool flow:

```text
start app + MCP
 -> MCP initialize without Authorization
 -> verify writes disabled by default
 -> enable writes in test config
 -> normalize_evidence
 -> create_video_project
 -> generation completes
 -> get_video_project == review_required
 -> prove no backend auto-approval/render/downstream stage exists
 -> test harness invokes approve_video_project
 -> external review acknowledgment recorded
 -> start_video_render
 -> media ingest
 -> TTS
 -> render
 -> completed
 -> signed MP4 download
```

The deterministic E2E does **not** prove a real human reviewed the draft; it proves backend lifecycle/tool behavior. Human/client confirmation timing belongs to T28.

Also retain representative:

- write kill-switch zero-mutation case;
- rate-limit/in-flight/active-project cap cases;
- reopen/restart;
- duplicate tool calls/idempotency;
- stale edit/approval;
- direct backend unauthenticated rejection;
- retry/cancel/stale-owner fencing;
- signed-download tamper/expiry;
- source prompt-injection-looking content as inert data.

### T28 — Live ChatGPT bounded noauth acceptance + docs/ship closure

Run against the actual deployed exact HEAD/image.

Before the run:

- external MCP ingress is intentionally enabled for the acceptance window;
- `MCP_NOAUTH_WRITE_ENABLED=true` is set explicitly;
- configured rate/in-flight/active-project limits are recorded.

Path A:

```text
ChatGPT connects without OAuth linking
 -> normalize_evidence
 -> create_video_project
 -> review_required
 -> draft shown
 -> ChatGPT does not call approval/render before user action
```

Path B:

```text
user explicitly confirms/continues
 -> approve_video_project
 -> external review acknowledgment recorded
 -> start_video_render
 -> completed
 -> MP4 downloadable/playable
```

Record:

- exact HEAD/image;
- actual tool calls;
- project IDs/status transitions;
- bounded approval provenance without claiming authenticated user identity;
- configured no-auth capacity values;
- acceptance-window enable time;
- completed download/playback;
- no secrets or sensitive conversation content.

After the run:

- set `MCP_NOAUTH_WRITE_ENABLED=false` and/or withdraw external ingress;
- record the disable/withdraw time;
- only then may status docs and PR body claim the noauth acceptance run completed.

## Verification Checkpoints

### Checkpoint A — External transport reset

Require all:

- MCP works without Authorization;
- tools advertise `noauth`;
- OAuth/DCR/session routes are absent or unreachable as active product surface;
- writes are disabled by default;
- body/deadline/rate-limit/Host/Origin/capacity protections remain green;
- private backend still rejects missing/wrong service credentials.

### Checkpoint B — Approval reset

Require all:

- backend path stops at `review_required`;
- MCP caller cannot choose actor/mode/delegation state;
- stale revision/hash fails;
- valid external review acknowledgment works when writes are enabled;
- storage/logging does not claim authenticated human review;
- no delegated positive runtime path remains.

### Checkpoint C — Runtime/output

Require all:

- render/retry/cancel preserve durable semantics;
- all mutating tools honor kill-switch/capacity controls;
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
- write-window disable/ingress-withdraw evidence after live acceptance;
- project-wide Definition of Done;
- docs/PR body synchronized to observed truth.

## Security Posture During Temporary Noauth Mode

This milestone knowingly accepts that anyone who can reach the MCP endpoint can invoke exposed tools while temporary writes are enabled.

Therefore:

- do not describe the external MCP surface as authenticated;
- do not describe approval as authenticated human review;
- writes default to disabled;
- keep bounded global rate, in-flight write, and active-project limits;
- keep private backend service authentication;
- keep idempotency/fencing to limit duplicate durable work;
- use a bounded acceptance/test exposure window rather than an always-on public posture;
- reintroduce authenticated external access only as a separately planned trust-boundary milestone.

## Rollback

The reset should require no destructive database migration.

If live noauth exposure is unacceptable:

1. set `MCP_NOAUTH_WRITE_ENABLED=false`;
2. disable/withdraw public MCP ingress;
3. leave the private Bright Profile backend unchanged;
4. do **not** fall back to the partially implemented OAuth subsystem;
5. plan a separate authenticated resource-server/IdP integration milestone.

## Plan Exit Condition

This plan is complete when implementation, tests, Compose/CI, deterministic E2E, live ChatGPT acceptance, and docs all describe one coherent truth:

```text
noauth ChatGPT -> MCP
anonymous writes disabled by default and bounded when enabled
private service-authenticated MCP -> Bright Profile
external review acknowledgment, not authenticated human proof
signed authoritative MP4 delivery
OAuth + delegated_e2e deferred
```
