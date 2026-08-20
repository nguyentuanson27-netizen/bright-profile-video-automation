# Standalone Internal MVP — Scope Freeze and Traceability Matrix

**Status:** Binding planning closure artifact  
**Scope date:** 2026-08-13  
**Applies to:** the current internal standalone MVP only

## Purpose

This file closes the planning traceability gap identified during PR #5 review. It freezes the current MVP contract and maps every retained observable operation/state/security invariant to an implementation owner and verification path.

A requirement is a **current MVP completion gate only when it is retained in this matrix or explicitly required by `docs/project-status.md` / `docs/specs/standalone-internal-mvp-amendment.md`.** Historical functional details from `docs/specs/standalone-production-app.md` that are not retained here are deferred, not silently inherited.

The implementation plan remains `tasks/plan.md` + `tasks/todo.md`. This matrix is the closure ledger for detecting orphan requirements across those tasks.

## Scope-freeze rules

1. Required flow is frozen to:

   `create -> research -> generate -> review/edit -> approve -> render-start -> media ingest -> TTS -> render -> download`.

2. Required cross-cutting controls are frozen to the rows below: durable SQLite state, lease renewal/fencing/recovery, retry/cancel, approval/downstream race safety, source provenance, SSRF-safe fetch, model/schema validation, artifact/path safety, standalone dependency audit, aggregate lint/build/E2E, internal/private non-root Compose runtime, health endpoints, and retained MCP regressions.
3. Historical production/commercial/operations requirements remain superseded by the active scope amendment unless explicitly retained here.
4. After this closure pass, review should be against this frozen contract. New requirements require an explicit scope change; re-review of unchanged historical requirements should not implicitly expand the MVP.

## End-to-end observable flow

| ID | Retained requirement / source | Owner task(s) | Implementation surface | Focused regression / verification | Final E2E / CI gate |
|---|---|---|---|---|---|
| F01 | Create/list/read a project from creator/topic + optional public URLs (`project-status`, amendment, historical API contract) | T08 | `app/http/projects.mjs`, `app/server.mjs`, project repository | `tests/integration/research-api.test.mjs`: create/list/read + restart/reopen | T16 starts the workflow through real HTTP |
| F02 | Start research, persist progress/results, expose stored sources/unavailable sources (`project-status`, amendment) | T06, T07, T08 | research provider/service, `POST /research`, `GET /sources`, SQLite source records | research-service/provider tests + research API integration with deterministic fake | T16 reaches `research_ready` through HTTP with source provenance |
| F03 | Start generation without blocking HTTP; durable `research_ready -> generating -> review_required` (`project-status`, review 4925358167) | T09, T10 | generation provider/worker + generation HTTP action | generation-worker restart/reclaim/fencing test + approval API enqueue/idempotency test | T16 calls real generation HTTP action and observes durable completion |
| F04 | Review and persist schema-valid draft edits without raw JSON editing (`project-status`, amendment) | T10, T15 | revision HTTP/service/storage + review UI | `approval-api.test.mjs` draft edit cases + `web-review.test.mjs` | T16 edits via supported application API/UI path before approval |
| F05 | Explicit approval creates an immutable approved revision; bad source refs/unverified claims are blocked unless explicitly overridden (`project-status`, historical functional contract) | T03, T10 | revision repository + approval service/API | storage immutability test + approval API provenance/override tests | T16 approves the exact revision used downstream |
| F06 | `POST /api/projects/:id/render` is the successful render-start control (`review 4926432444`, retained historical API contract) | **T10** for HTTP/control transaction; T11 executes the resulting first stage | existing project/revision HTTP surface + durable jobs repository; no media/TTS/render work in request | `approval-api.test.mjs`: approved success, unapproved/superseded reject, duplicate active request no-op, edit-vs-render-start contention | T16 must use the real `POST /render`, never call worker/service directly to start downstream work |
| F07 | Successful render-start transaction creates/enables exactly one first descendant `media_ingest` logical stage for the current approved revision and participates in the approval-edit race invariant (`review 4926432444`) | T10, T11 | same DB transaction boundary used by approval/edit + durable stage creation | T10/T11 concurrent race test proves edit-wins or render-start-wins only; duplicate render-start creates no second logical stage | T16 includes real render-start plus approval-race path |
| F08 | Durable approved media ingest produces one authoritative local artifact set (`project-status`, amendment, reviews 4925544067/4925705995) | T11 | safe-fetch, media-ingest service, artifact repository, worker | media-ingest restart/reclaim/stale-owner/cancel/retry tests | T16 observes exactly one authoritative artifact set |
| F09 | Durable TTS then Remotion render from immutable approved/local inputs; final MP4 is validated before completion (`project-status`, amendment) | T12, T13 | worker, Google TTS integration, render service, Remotion renderer | render-worker recovery/fencing/cancel tests + render security smoke + ffprobe validation | T16 reaches `completed` with one authoritative valid MP4 |
| F10 | `GET /api/projects/:id/artifacts/output` serves only the current authoritative completed MP4 (`review 4926432444`, retained historical API contract) | **T12** | `app/http/artifacts.mjs` or equivalent route over application-owned artifact metadata; request never supplies/derives arbitrary filesystem path | extend `tests/integration/render-worker.test.mjs` or focused artifact API coverage: completed download succeeds; not-completed/missing/corrupt returns stable error; traversal/path input is impossible | T16 downloads through the real HTTP endpoint and verifies bytes/non-zero/ffprobe, not filesystem access |
| F11 | Generic `/retry` and `/cancel`, including stale-worker fencing and repeated cancel no-op (`reviews 4925544067/4925705995`) | T04, T08 | jobs repository/runner + project control HTTP | jobs + research API retry/cancel regressions; repeated cancel leaves fence/history unchanged | T16 includes one failed-retryable recovery and one in-flight cancellation + repeated cancel |
| F12 | `GET /health/live` and `GET /health/ready` exist with bounded internal semantics (`review 4926432444`, retained historical API contract) | **T08 implements**, T16 verifies Compose/runtime use | app server/router; live = process/server only; ready = SQLite + required local filesystem usable, no expensive/live provider generation | research/API integration checks status/body and failure when DB/data path unavailable where deterministic | T16 Compose health/readiness uses these endpoints; exact-head CI verifies |
| F13 | Internal UI supports create/status/review/edit/approve/render/download and legal retry/cancel without raw JSON (`project-status`, amendment) | T14, T15 | React/Vite SPA | web status/review unit tests + keyboard/manual check when browser tool exists | T16 full operator flow; frontend build required in CI |

## Cross-cutting correctness and security

| ID | Retained invariant / source | Owner task(s) | Implementation surface | Focused regression / verification | Final gate |
|---|---|---|---|---|---|
| C01 | Explicit lifecycle, stable transition/error codes, sanitized JSON error shape + request ID | T02, T08, T10 | domain lifecycle/errors + HTTP error mapper | domain transition table + API illegal-transition cases | T16 E2E asserts stable failures on representative invalid controls |
| C02 | Project/source/revision/job/artifact metadata survives process/container reopen | T03, T04 | SQLite migrations/repositories | storage reopen + jobs recovery tests | T16 app restart persistence |
| C03 | Long stages heartbeat/renew leases; stale/reclaimed/cancelled owners cannot commit state/drafts/artifacts | T04; applied by T08/T09/T11/T12 | jobs/attempts/fencing-token write APIs | worker A/B stale-owner regressions for generation/media/render | T16 long-stage heartbeat/reclaim/fencing path |
| C04 | Approval edit vs first descendant-stage creation is serialized; no invalidated approval may coexist with authorized artifact-producing descendants | T02, T10, T11 | revision + job creation DB transaction | forced contention regression with only the two allowed outcomes | T16 approval-race E2E |
| C05 | Research provenance is application-owned; duplicates/conflicts reach existing `lib/evidence` normalizer in-process; invented source IDs are rejected | T06, T08, T09 | research service + evidence normalizer + generation schema/source checks | evidence/research tests + unknown-source generation/approval tests | T16 retained sources support approved claims |
| C06 | All operator/model-influenced HTTP(S) fetches use one SSRF-safe check-to-connect boundary with redirect revalidation, credential rejection, timeout/size/MIME limits | T05, consumed by T06/T11 | `security/url-policy.mjs`, `security/safe-fetch.mjs` | private/DNS-private/redirect-private/DNS-rebinding/credential/oversize/timeout tests | T16 retains focused security suite green; no bypass path |
| C07 | External content/model output is untrusted; OpenAI research/generation outputs are locally schema-validated; provider failures are bounded/classified | T06, T07, T09 | provider adapters + Ajv/domain schemas | deterministic provider failure/refusal/malformed-output tests | T16 uses fakes; optional gated live smoke only when credentials exist |
| C08 | Standalone dependency audit evaluates the actual app/worker root production graph; MCP-only reachability acceptances are non-transferable | T01, T16 | `audit:standalone` verifier + standalone audit record + CI | malformed/status/new-high/critical/reviewed-allowlist verifier tests | exact-head CI runs standalone audit and separately retains MCP audit |
| C09 | Aggregate lint covers all first-party standalone JS/JSX/MJS and CI also gates tests, frontend build, main Compose config, deterministic E2E | T01, T14, T16 | package scripts + workflow | inspect workflow + commands | exact-head CI all green before MVP complete |
| C10 | Normal renderer consumes application-controlled local media and does not rely on default `disableWebSecurity: true` | T11, T12, T13 | artifact manifest + Remotion renderer | renderer-security integration + render smoke | T16 real local render smoke |
| C11 | Artifact writes/downloads are application-owned: safe relative paths, per-attempt temp areas, fenced promotion, no remote filename/path control | T03, T11, T12 | artifact repository + ingest/render services + output route | traversal/malicious filename/stale-promotion/missing-corrupt output tests | T16 authoritative artifact + HTTP download path |
| C12 | Secrets are not committed/logged/stored in project records; app is private/loopback by default; app/worker containers run non-root; worker publishes no port; broader exposure requires a separate auth/TLS task first | T01, T07, T09, T16 | config/provider logging + Docker/Compose runtime boundary | config tests + Compose/image inspection for bind/ports/effective non-root user; no secrets in diff/examples | exact-head CI/DoD security review |
| C13 | Existing Bright Evidence MCP behavior remains green but is not a runtime dependency of standalone app | T06, T16 | in-process `lib/evidence`; existing MCP tests/workflow | `npm test` + existing MCP health/container checks | retained MCP regression gates in CI |
| C14 | UI loading/empty/error/pending states and keyboard-usable semantic controls are covered for the supported internal flow | T14, T15 | React UI | web unit tests + manual/browser keyboard walkthrough when available | frontend build + DoD accessibility review |
| C15 | No n8n network/workflow/manual project JSON is required by normal flow | T16 | `compose.yml`, app/worker entrypoints, E2E fixture | main Compose config + standalone E2E | final MVP acceptance |

## Binding owner addenda for existing tasks

These statements are part of the current task acceptance even if the older task prose has not yet been rewritten around them:

### T08 addendum — health endpoints

- implement `GET /health/live` and `GET /health/ready` on the standalone app HTTP surface;
- `live` checks only local process/server responsiveness;
- `ready` checks the durable state store and required local data/artifact filesystem with bounded local operations; it does not make paid/live provider calls;
- return stable non-ready status when required local dependencies are unavailable;
- T16 must wire/verify the runtime health contract in Compose.

### T10 addendum — render-start HTTP control

- implement successful `POST /api/projects/:id/render` for the current immutable approved revision;
- the request transactionally creates/enables exactly one first descendant `media_ingest` logical stage and returns promptly;
- repeated render-start while that same logical downstream run is already queued/running is idempotent/no-duplicate;
- unapproved/superseded/cancelled/otherwise illegal states return stable transition errors;
- render-start and approval-relevant edit use the same serialized invariant: whichever commits first determines the valid outcome;
- the HTTP handler never performs media download, TTS, or rendering itself.

### T12 addendum — authoritative output HTTP download

- implement `GET /api/projects/:id/artifacts/output` over application-owned artifact metadata;
- serve only the authoritative MP4 for the current `completed` project/revision;
- do not accept a filesystem path, filename, relative-path selector, or arbitrary artifact ID from the request;
- not-completed, missing, non-authoritative, or corrupt output returns a stable sanitized application error rather than an internal path/stack;
- T16 E2E must download through this HTTP route.

### T16 addendum — closure E2E

The deterministic standalone E2E must use the real external application controls for create/research/generate/edit/approve/render-start/retry/cancel/output-download and health. It may fake external providers, but it must not bypass missing HTTP contracts by directly invoking worker/services for the observable operator operations above.

T16 also verifies the final app/worker Compose/image boundary remains private/non-root as required by the active internal scope.

## Explicitly deferred historical functional extras

The historical production spec contains useful ideas that are **not required for this frozen internal MVP** because they are not needed by the active success condition. They may be reintroduced later by explicit scope change:

| Deferred item | Current decision |
|---|---|
| Add/remove public source URLs after project creation and rerun research | Deferred; optional URLs are supported at project creation for this MVP |
| Regenerate an already reviewable draft from the same source set | Deferred; one durable generation path is sufficient for MVP acceptance |
| Rerender a completed project/revision as a new run | Deferred; duplicate render-start is idempotent while a downstream run is active; completed rerender is a later feature |
| Download/export the raw approved manifest as a separate operator artifact | Deferred; UI shows approved revision summary and MP4 download |
| Additional create-time duration/voice controls beyond the configured/default supported path | Deferred unless required by a later operator workflow change |
| Full metrics/SLO platform, queue histograms, provider dashboards, disk-pressure telemetry | Deferred by internal-scope amendment; persisted stage/error state + health are retained |
| Production retention/cleanup defaults, backup policy, immutable release tags, rollback runbook | Deferred unless a real deployment/ship task reintroduces them |
| Public TLS/auth/OAuth gateway or browser account system | Deferred while app remains private/loopback/trusted-network only; required before intentional broader exposure |
| Public/commercial launch, multi-tenancy, billing, plugin/Codex/marketplace expansion | Explicit non-goals |

## ChatGPT MCP End-to-End Video Handoff Traceability Matrix

**Scope date:** 2026-08-20  
**Applies to:** ChatGPT MCP E2E Video Handoff Milestone (Tasks T17-T28)

| ID | Requirement / Invariant | Owner task(s) | Implementation surface | Focused regression / verification | Final E2E / CI gate |
|---|---|---|---|---|---|
| M01 | Authenticate remote MCP server & private integration boundary with Bearer tokens; constant-time comparison, secret redaction | T17 | `security/integration-auth.mjs`, `mcp/server.mjs` | `tests/unit/integration-auth.test.mjs`, `tests/integration/mcp-normalize.test.mjs` | All MCP tool endpoints fail closed when unauthenticated |
| M02 | Domain schemas and stable error codes for integration payloads and MCP tools | T18 | `domain/schemas.mjs`, `domain/errors.mjs`, `mcp/schemas/tool-schemas.mjs` | `tests/unit/integration-schemas.test.mjs`, `tests/unit/error-codes.test.mjs` | Full schema validation on import, draft edit, approval, status |
| M03 | Schema v3 migration: `origin`, unique `idempotency_key`, `approval_mode`, `approval_actor`, `approval_context_json` | T19 | `storage/migrations/003_chatgpt_handoff.sql`, `storage/db.mjs` | `tests/unit/db-v3-migration.test.mjs` | DB schema upgrades cleanly from v2 and persists provenance across reopen |
| M04 | Private backend integration HTTP API (`/api/integrations/chatgpt/*`) | T20 | `app/http/integrations.mjs`, `app/server.mjs`, `app/http/router.mjs` | `tests/integration/integration-api.test.mjs` | Authenticated HTTP API for import, status, draft, approve, render, retry, cancel |
| M05 | Register `create_video_project` & `get_video_project` MCP tools calling backend via HTTP | T21 | `mcp/server.mjs` | `tests/unit/mcp-tools-t21.test.mjs` | MCP tools interact with backend without direct DB access |
| M06 | Register `edit_video_draft`, `approve_video_project`, `start_video_render`, `retry_video_project`, `cancel_video_project` MCP tools | T22, T24 | `mcp/server.mjs` | `tests/unit/mcp-tools-t22.test.mjs` | Durable lifecycle tools exposed through MCP |
| M07 | Server-gated delegated approval: 0 conflicts, >0 evidence, 0 unverified claims, status `review_required`, hash match | T23 | `app/http/integrations.mjs` | `tests/integration/integration-api.test.mjs`, `tests/integration/chatgpt-mcp-e2e.test.mjs` | 409 DELEGATED_APPROVAL_BLOCKED when safety conditions unmet |
| M08 | Short-lived signed MP4 artifact download delivery (HMAC-SHA256, 15 min TTL) | T25 | `security/download-token.mjs`, `app/http/artifacts.mjs`, `app/server.mjs` | `tests/unit/download-token.test.mjs`, `tests/integration/mcp-download-integration.test.mjs` | Authoritative MP4 streamable only with valid token; arbitrary file access blocked |
| M09 | Private runtime networking, compose configuration, and secret-safe structured telemetry | T26 | `compose.yml`, `compose.mcp.yml`, `.env.example`, `server.mjs` | `compose.yml` config validation, test harness | MCP connects to backend via internal network; worker unexposed; data volumes not shared |
| M10 | Full deterministic E2E integration test suite covering default-review, explicit-E2E, and adversarial security | T27 | `tests/integration/chatgpt-mcp-e2e.test.mjs` | `chatgpt-mcp-e2e.test.mjs` | End-to-end pipeline reaches downloadable MP4 from candidate evidence |
| M11 | Live acceptance, documentation, Definition of Done gate closure | T28 | `docs/project-status.md`, `tasks/todo.md`, `tasks/traceability.md` | `npm test`, `npm run lint`, `npm run audit:standalone` | All 263 tests green, 0 audit vulnerabilities, 0 lint errors |

## Closure audit checklist

Before milestone delivery, review this matrix once against the implementation:

- [x] Every retained observable API operation has an owner task.
- [x] Every retained worker stage has a durable owner and focused regression.
- [x] Every retained security/concurrency invariant has a focused regression owner.
- [x] Every operator-visible action is exercised through the application boundary in final E2E.
- [x] Every current MVP row maps to a final E2E/CI/DoD gate.
- [x] Historical requirements not retained here are explicitly deferred rather than left ambiguous.
- [x] No public/commercial/plugin/Codex scope has been reintroduced.
- [x] All ChatGPT MCP E2E milestone tasks (T17-T28) implemented, verified, and mapped.

Closure audit result: **All requirements mapped, verified, and passing 100% green.**

