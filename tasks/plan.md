# Implementation Plan: ChatGPT MCP Temporary No-Auth Reset

**Primary spec:** `docs/specs/chatgpt-mcp-e2e-video-handoff.md`  
**Baseline status:** `docs/project-status.md`  
**Completed predecessor milestone:** standalone T01-T16 on `main`  
**Plan status:** T17-T27 implemented and CI-verified; T28 live acceptance open
**Reset date:** 2026-08-21  
**Task range retained:** T17-T28

## Goal

Stop iterating on a home-grown OAuth/delegated-authorization implementation and reset the current ChatGPT MCP milestone around the smallest coherent contract that can be verified now:

```text
ChatGPT
  -> no-auth MCP
  -> Bright MCP tool surface
  -> private authenticated Bright Profile integration API
  -> supplied ChatGPT draft at review_required
  -> user checkpoint
  -> durable media/TTS/render pipeline
  -> authoritative MP4
```

The current milestone does **not** claim authenticated human review. Its approval semantic is `external_review_acknowledged`: the tested ChatGPT flow should invoke approval only after the user confirms/continues, while the no-auth backend records only that the external flow acknowledged review. OAuth and `delegated_e2e` are explicitly deferred to a later trust-boundary milestone.

If the existing database continues to persist `approval_mode='user_reviewed'`, that value is treated as a legacy storage label for `external_review_acknowledged` during this milestone, not as proof of authenticated human review.

## Why This Reset Exists

The previous implementation combined too many security roles inside `mcp/server.mjs`: external OAuth authorization server, user-login/session system, OAuth resource server, static bearer auth, MCP server, private backend service client, and download proxy. Review repeatedly found variants of the same root problem: the runtime lacked a trustworthy source of project-specific human authorization for delegated execution, while the MCP process was also implementing its own identity system.

The no-auth reset removes those root causes instead of patching individual OAuth/delegation findings. Because anonymous access is deliberately accepted only for a temporary acceptance/test window, the reset requires explicit operational guardrails, a **durable** active-work capacity invariant, and mandatory ingress teardown after acceptance.

## Scope Decisions

### In scope

- explicit ChatGPT-facing MCP `noauth` transport;
- existing video handoff tools;
- private MCP -> Bright Profile HTTP integration protected by `BRIGHT_INTEGRATION_TOKEN`;
- imported EvidenceBundle + complete ChatGPT draft -> direct `review_required` for the supported T28 path;
- omitted-draft backend generation retained only as a compatibility path;
- backend stop at `review_required`;
- draft edit and external review acknowledgment approval;
- render/retry/cancel using existing durable backend semantics;
- signed authoritative MP4 delivery;
- Host/Origin, body-size, request-deadline, rate-limit, logging, SSRF, artifact, and worker-fencing controls;
- default-off no-auth write kill switch;
- bounded anonymous request/concurrency/project capacity;
- **transactional Bright Profile admission** for any create/retry/reactivation that adds active ChatGPT-origin work;
- deterministic no-auth end-to-end regression;
- live ChatGPT no-auth acceptance in a bounded ingress/write-enabled window;
- mandatory post-acceptance write disable **and** external ingress withdrawal.

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
   | noauth MCP (temporary ingress)
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
   |-- transactional active-work admission
   `-> durable worker -> media/TTS/render -> authoritative MP4
```

## Temporary No-Auth Deployment Contract

```text
MCP_NOAUTH_WRITE_ENABLED=false
MCP_RATE_LIMIT_PER_MINUTE=20
MCP_MAX_INFLIGHT_WRITE_REQUESTS=2
MCP_MAX_ACTIVE_PROJECTS=3
```

Semantics:

- writes are **off by default**;
- `NOAUTH_WRITE_DISABLED` is returned before backend side effects when writes are disabled;
- `MCP_MAX_INFLIGHT_WRITE_REQUESTS` bounds simultaneous anonymous mutating calls at the MCP edge;
- `MCP_MAX_ACTIVE_PROJECTS` is a **durable global invariant** over non-terminal `origin=chatgpt_mcp` projects that can own/queue active work;
- Bright Profile, not a process-local MCP counter, is authoritative for active-project admission;
- admission occurs in the same SQLite transaction that creates or reactivates active work;
- create, retry/requeue/reactivation, and any future inactive/terminal -> active transition use the same admission invariant;
- idempotent replay that only returns an existing result does not allocate a new slot;
- concurrent callers/processes cannot commit state above the configured active-project cap;
- capacity failure returns `NOAUTH_CAPACITY_REACHED` with zero new project/job/attempt/reactivation mutation;
- no no-auth limit may default to unlimited;
- T28 may enable ingress/writes only for the explicit acceptance window;
- T28 teardown requires **both** `MCP_NOAUTH_WRITE_ENABLED=false` and withdrawal of the external HTTPS MCP ingress;
- a later test window must be opened explicitly rather than leaving T28 ingress running.

## Approval Truth Contract

- **Client behavior to verify live:** ChatGPT shows the review state and waits for user confirmation before invoking `approve_video_project`.
- **Backend guarantee:** the backend itself does not auto-approve at `review_required`; approval is revision/hash/state/schema fenced.
- **Backend limitation in noauth mode:** an arbitrary anonymous caller can invoke approval while the temporary ingress/writes are enabled, so the backend cannot prove a real human reviewed the draft.
- **Audit semantics:** record `external_review_acknowledged` at the integration/docs level and a bounded actor/origin such as `chatgpt_mcp_noauth`; never claim an authenticated human identity.
- **Storage compatibility:** if schema v3 retains `approval_mode='user_reviewed'`, map/document it as the legacy persistence value for the above external acknowledgment only.

## Dependency Graph

```text
T17  noauth transport + kill switch + edge request limits
 |
 +--> T21  noauth tool surface
 |
 +--> T26  remove OAuth deployment state + temporary ingress contract
 |
T20  backend import + transactional active-work admission
 |
 +--> T24  retry/reactivation uses same durable admission
 |
T18 + T22 + T23  truthful approval + delegated removal
 |
T25  signed output
 |
T17-T26 --> T27 deterministic/adversarial verification
              |
              +--> T28 bounded live acceptance + mandatory teardown
```

## Execution Order

1. contract/spec reset;
2. external MCP `noauth` transport + default-off write kill switch;
3. delete OAuth/DCR/session runtime surface;
4. add transactional backend active-work admission before relying on active-project caps;
5. simplify Compose/env/CI and add finite edge limits;
6. collapse approval to external review acknowledgment semantics;
7. remove delegation implementation/routes/tests;
8. ensure retry/reactivation uses the same durable active-work admission;
9. rewrite deterministic E2E around the actual no-auth review-acknowledged flow and capacity races;
10. run full verification;
11. run live ChatGPT acceptance in a bounded ingress/write-enabled window;
12. restore write-disabled state **and withdraw external MCP ingress** before docs/PR closure.

Do not start by repairing OAuth or by implementing a process-local active-project counter as the source of truth.

## Task Details

### T17 — Temporary no-auth MCP boundary + private service auth + edge guards

**Outcome:** external ChatGPT -> MCP does not require OAuth/static bearer; private MCP -> app remains authenticated; anonymous writes are default-off and edge concurrency is bounded.

Implementation requirements:

- `/mcp` initialize/tool discovery/legal calls work without `Authorization`;
- all active tools advertise `securitySchemes: [{type: 'noauth'}]`;
- remove external auth dispatch/fallback logic from `mcp/server.mjs`;
- preserve Host/Origin, request size, request deadline, rate limit, protocol validation, and secret-safe logging;
- keep `BRIGHT_INTEGRATION_TOKEN` for MCP -> app;
- direct integration API calls without the service token remain fail-closed with zero durable mutation;
- implement `MCP_NOAUTH_WRITE_ENABLED=false` by default;
- disabled writes fail with `NOAUTH_WRITE_DISABLED` before backend side effects;
- implement finite rate and in-flight write limits;
- do not treat an MCP-local active-project count as authoritative.

Verification:

- noauth initialize/list/call tests;
- kill-switch negative tests with zero mutation;
- rate/in-flight capacity tests;
- negative direct-backend service-auth tests;
- body/deadline/rate-limit/Host/Origin regressions remain green.

### T18 — Simplify handoff/approval contracts

**Outcome:** active public MCP contract no longer exposes auth/delegation concepts or falsely claims authenticated human review.

Required changes:

- `approve_video_project` input contains only project/revision/hash fields needed for approval;
- caller cannot choose approval mode or actor;
- caller cannot provide `delegationGrant` or `delegatedContext`;
- MCP adapter records external review acknowledgment with bounded actor/origin `chatgpt_mcp_noauth` or equivalent;
- if backend storage still requires `mode=user_reviewed`, treat it as a compatibility mapping only;
- API/tool responses, tests, docs, and logs must not describe that legacy value as authenticated human proof.

Keep existing revision/hash/schema/source legality checks authoritative.

### T19 — Retain existing durable ChatGPT handoff migration

**Outcome:** keep already-added durable integration/idempotency/origin/approval provenance storage where useful.

Do not add a destructive migration merely to remove deferred OAuth/delegation behavior or rename the compatibility enum.

Verify migration/reopen behavior and ensure no OAuth client/session/token persistence remains required.

### T20 — Retain private backend EvidenceBundle import + durable capacity admission

**Outcome:** existing import path remains authoritative/service-authenticated, supports the T28 draft handoff and the omitted-draft compatibility path, and a new ChatGPT-origin project cannot exceed the durable active-work cap.

Requirements:

- backend revalidates EvidenceBundle;
- same idempotency key returns the same project before allocating a second capacity slot;
- imported research does not call backend research provider;
- when a complete draft is supplied, validate/remap its evidence references and persist directly at `review_required` without a generation job;
- when draft is omitted, enter `research_ready` and queue generation as a compatibility path that may require the backend OpenAI provider;
- state survives reopen;
- for a genuinely new project, the backend checks current active ChatGPT-origin count and creates/enqueues the project in the **same SQLite transaction**;
- if the cap is full, return `NOAUTH_CAPACITY_REACHED` and commit no new project/job;
- two concurrent new creates at the last available slot cannot both commit.

No external OAuth concern belongs in this task.

### T21 — Convert MCP tool surface to noauth

**Outcome:** all supported tools are callable without external bearer/OAuth linking, subject to the write gate for mutating tools.

Required changes:

- tool metadata = `noauth`;
- remove OAuth scope checks and synthetic authenticated-user context;
- retain bounded schemas/output normalization/backend client behavior;
- retain correlation IDs across MCP -> backend;
- apply write gate + in-flight capacity before write-side backend dispatch;
- defer authoritative active-project admission to Bright Profile.

Checkpoint A:

```text
no Authorization -> initialize succeeds
no Authorization -> tools/list succeeds
writes disabled -> mutating tool fails before backend mutation
writes enabled -> legal mutating tool reaches private backend
OAuth routes are not needed
rate/body/deadline/Host protections still work
```

### T22 — Review/edit/external-review-acknowledgment path

**Outcome:** backend stops at review; live ChatGPT proceeds only after user confirmation; audit remains truthful about no-auth limitations.

Required negative cases include premature backend approval, stale revision/hash, invalid draft/source refs, caller-selected actor/mode/delegation, and any response/log/test claiming authenticated human review.

### T23 — Remove/defer delegated E2E authorization

Remove/deactivate delegated mode/grants/routes/runtime inputs/positive-path tests. Keep DB approval columns only where removing them would create unnecessary migration churn.

### T24 — Retain render/retry/cancel wrappers + capacity-aware retry

Verify:

- all write wrappers honor write kill switch and in-flight gate;
- render-start remains idempotent;
- retry only works for retryable durable failure;
- when retry/requeue changes a failed/inactive ChatGPT-origin project back to active, Bright Profile performs capacity admission in the **same transaction** that creates replacement work;
- if the cap is full, retry returns `NOAUTH_CAPACITY_REACHED` with zero replacement attempt/job/state mutation;
- repeated retry for already queued/running replacement work remains idempotent and does not consume another slot;
- cancel preserves stale/current owner fencing.

### T25 — Retain signed authoritative MP4 delivery

Verify exact project/revision/artifact binding, expiry/tamper rejection, authoritative file validation, streaming/backpressure, timeout/rate limit, and no arbitrary path/file selection.

### T26 — Remove OAuth deployment/config/runtime state + define temporary ingress

Remove:

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

Compose/CI must prove app/worker remain private, MCP has no Bright storage mounts, temporary remote access uses only the intended HTTPS MCP ingress, no OAuth persistence volume remains, and no no-auth limit defaults to unlimited.

T28 closure additionally requires proving the remote MCP ingress was withdrawn after acceptance; leaving it public with writes disabled is not acceptable because status/draft/output metadata is anonymous while ingress remains open.

### T27 — Deterministic noauth full E2E + adversarial regression

Supported T28 contract regression:

```text
start app + MCP
 -> initialize without Authorization
 -> prove writes disabled by default
 -> enable writes in test config
 -> normalize_evidence
 -> construct complete structured draft from normalized evidence IDs
 -> create_video_project({ evidenceBundle, draft, ... })
 -> review_required with no generation job
 -> prove no backend auto-approval/render
```

Retained compatibility/lifecycle E2E:

```text
start app + MCP
 -> initialize without Authorization
 -> prove writes disabled by default
 -> enable writes in test config
 -> normalize_evidence
 -> create_video_project without draft
 -> generation -> review_required
 -> prove no backend auto-approval/render
 -> invoke approve_video_project
 -> external review acknowledgment
 -> start_video_render
 -> media/TTS/render
 -> completed
 -> signed MP4 download
```

Adversarial/recovery coverage must include:

- write kill switch zero-mutation;
- rate/in-flight enforcement;
- active-cap rejection on new create;
- active-cap rejection on retry/reactivation;
- concurrent admission race at the last available slot (for example one new create + one retry) proving committed active count never exceeds the cap;
- idempotent create/retry replay does not consume duplicate slots;
- DB reopen/restart;
- stale edit/approval;
- direct backend no/wrong service token;
- retry/cancel/stale-owner fencing;
- signed-download tamper/expiry;
- source prompt-injection-looking content as inert data.

The compatibility E2E verifies the retained backend generation lifecycle; it is not the T28 client path. Automated verification does **not** prove a real human reviewed the draft; human/client confirmation timing belongs to T28.

### T28 — Live ChatGPT bounded noauth acceptance + docs/ship closure

Before the run:

- deploy exact implementation HEAD/image;
- enable external HTTPS MCP ingress only for the bounded acceptance window;
- set `MCP_NOAUTH_WRITE_ENABLED=true` explicitly;
- record rate/in-flight/active-project values and ingress enable time.

Path A:

```text
ChatGPT connects without OAuth linking
 -> normalize_evidence
 -> construct complete structured draft from normalized evidence IDs
 -> create_video_project({ evidenceBundle, draft, ... })
 -> review_required
 -> draft shown
 -> ChatGPT does not call approval/render before user action
```

Path A is keyless: it must not omit `draft` or depend on the compatibility generation path/`OPENAI_API_KEY`.

Path B:

```text
user explicitly confirms/continues
 -> approve_video_project
 -> external review acknowledgment
 -> start_video_render
 -> completed
 -> MP4 downloadable/playable
```

Mandatory teardown before T28 can close:

1. set `MCP_NOAUTH_WRITE_ENABLED=false`;
2. withdraw/disable the external HTTPS MCP ingress/reverse-proxy route;
3. verify the remote MCP endpoint is no longer externally reachable;
4. record both teardown timestamps.

There is no `and/or` shortcut here. If continued temporary testing is needed, open a new explicitly approved bounded window later.

## Verification Checkpoints

### Checkpoint A — External transport reset

Require noauth initialize/discovery, write-disabled behavior, route cleanup, finite edge controls, and private backend service-auth rejection.

### Checkpoint B — Approval reset

Require backend stop at `review_required`, no caller-selected auth/delegation semantics, stale-hash rejection, truthful external acknowledgment, and no delegated runtime path.

### Checkpoint C — Durable capacity/runtime/output

Require:

- transactional active-project admission at Bright Profile;
- create and retry/reactivation share the invariant;
- concurrent admission cannot exceed cap;
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
- live ChatGPT Path A and Path B evidence;
- write-disabled **and ingress-withdrawn** teardown evidence;
- project-wide Definition of Done;
- docs/PR body synchronized to observed truth.

## Security Posture During Temporary Noauth Mode

This milestone knowingly accepts that anyone who can reach the MCP endpoint can invoke exposed tools while the temporary ingress is open.

Therefore:

- do not describe the external MCP surface as authenticated;
- do not describe approval as authenticated human review;
- writes default to disabled;
- keep finite global rate/in-flight limits;
- enforce active-project capacity durably, not as a process-local best effort;
- keep private backend service authentication and durable idempotency/fencing;
- use a bounded acceptance/test exposure window;
- withdraw external MCP ingress after T28 acceptance;
- reintroduce authenticated external access only as a separately planned trust-boundary milestone.

## Rollback

The reset should require no destructive database migration.

If live noauth exposure is unacceptable:

1. set `MCP_NOAUTH_WRITE_ENABLED=false`;
2. withdraw public MCP ingress;
3. verify the remote endpoint is unreachable;
4. leave the private Bright Profile backend unchanged;
5. do **not** fall back to the partially implemented OAuth subsystem;
6. plan a separate authenticated resource-server/IdP integration milestone.

## Plan Exit Condition

This plan is complete when implementation, tests, Compose/CI, deterministic E2E, live ChatGPT acceptance, and docs all describe one coherent truth:

```text
noauth ChatGPT -> MCP only during a bounded ingress window
anonymous writes disabled by default and edge-bounded when enabled
active ChatGPT-origin work transactionally capped in Bright Profile
private service-authenticated MCP -> Bright Profile
external review acknowledgment, not authenticated human proof
signed authoritative MP4 delivery
OAuth + delegated_e2e deferred
T28 teardown = writes disabled + external ingress withdrawn
```
