# Project Traceability Ledger — Standalone Baseline + ChatGPT MCP Reset

**Status:** Binding traceability artifact with two explicit ledgers  
**Standalone scope date:** 2026-08-13  
**ChatGPT MCP reset scope date:** 2026-08-21  
**Applies to:** (1) frozen/completed standalone internal MVP T01-T16, and (2) open ChatGPT MCP temporary no-auth reset T17-T28

## Purpose and Ledger Boundaries

This file contains **two distinct traceability ledgers**:

1. **Standalone T01-T16 ledger — frozen/complete.** It preserves the scope-freeze and closure evidence for the promoted standalone internal MVP and must not be reopened merely because the ChatGPT MCP milestone changes.
2. **ChatGPT MCP T17-T28 ledger — open.** It tracks the temporary no-auth reset, including private MCP-to-app service authentication, truthful external-review-acknowledgment semantics, durable no-auth capacity guardrails, deterministic E2E, and bounded live ChatGPT acceptance with mandatory ingress teardown.

A requirement is a current completion gate only when it belongs to the relevant ledger or is explicitly required by `docs/project-status.md` / the active spec for that ledger. Historical requirements not retained by the applicable ledger are deferred, not silently inherited.

The implementation plan remains `tasks/plan.md` + `tasks/todo.md`. This file is the closure ledger for detecting orphan requirements across those tasks.

---

# Ledger A — Standalone Internal MVP (T01-T16, Frozen)

## Scope-freeze rules

1. Required flow is frozen to:

   `create -> research -> generate -> review/edit -> approve -> render-start -> media ingest -> TTS -> render -> download`.

2. Required cross-cutting controls are frozen to the rows below: durable SQLite state, lease renewal/fencing/recovery, retry/cancel, approval/downstream race safety, source provenance, SSRF-safe fetch, model/schema validation, artifact/path safety, standalone dependency audit, aggregate lint/build/E2E, internal/private non-root Compose runtime, health endpoints, and retained MCP regressions.
3. Historical production/commercial/operations requirements remain superseded by the active standalone scope amendment unless explicitly retained here.
4. New standalone requirements require an explicit scope change; re-review of unchanged historical requirements must not implicitly expand the completed standalone MVP.

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

These statements remain part of the completed standalone task acceptance.

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

---

# Ledger B — ChatGPT MCP Temporary No-Auth Reset (T17-T28, Open)

**Scope date:** 2026-08-21  
**Closure state:** OPEN — implementation and live acceptance must be re-verified against this matrix

| ID | Requirement / invariant | Owner task(s) | Implementation surface | Focused regression / verification | Final gate |
|---|---|---|---|---|---|
| M01 | External ChatGPT -> MCP is explicit `noauth`; initialize/list require no Authorization; write/cost-bearing tools are disabled by default with `MCP_NOAUTH_WRITE_ENABLED=false`; Host/body/deadline/rate-limit protections remain | T17, T21, T26 | `mcp/server.mjs`, tool metadata, Compose/env | noauth transport + kill-switch regressions | T27 noauth E2E + T28 bounded live connection without OAuth linking |
| M02 | MCP -> Bright Profile remains private/service-authenticated with `BRIGHT_INTEGRATION_TOKEN`; missing/wrong service auth causes zero mutation | T17, T20, T26 | `mcp/server.mjs`, `app/http/integrations.mjs`, Compose | integration API negative auth tests | T27 direct-backend negative path + runtime topology check |
| M03 | Public approval input exposes only project/revision/hash data; approval semantic is external review acknowledgment; any stored `user_reviewed` value is legacy compatibility data, not authenticated human proof | T18, T19, T22 | domain/MCP schemas, approval service/storage | schema + stale hash/revision + audit-semantics tests | T27 acknowledgment flow + T28 tested-client confirmation evidence |
| M04 | Schema v3 migration retains origin/idempotency/approval provenance without adding OAuth/session persistence dependency or destructive enum cleanup | T19 | `storage/migrations/003_chatgpt_handoff.sql`, repositories | migration/reopen tests | exact-head CI migration smoke |
| M05 | New ChatGPT-origin create admission is idempotent and transactionally serialized with active-project capacity; cap failure commits no new project/job | T19, T20 | integration API + project/job repositories/SQLite transaction | create/idempotency/cap/concurrent-last-slot tests | T27 durable admission gate |
| M06 | Retry/requeue/reactivation that changes a failed/inactive ChatGPT-origin project back to active uses the same durable active-project admission transaction; cap failure creates no replacement work | T24 | retry service + jobs/project repositories | retry-cap + idempotent-retry + concurrent create-vs-retry tests | T27 durable admission gate |
| M07 | MCP create/get/edit/approve/render/retry/cancel tools call backend over HTTP with no direct DB/artifact access and `noauth` metadata; mutating tools honor write-enable/in-flight gates, while Bright Profile remains capacity authority | T17, T21, T22, T24 | `mcp/server.mjs` + private backend | MCP tool unit/integration + edge-capacity tests | T27 full tool path |
| M08 | T28 supplies a complete ChatGPT draft and reaches `review_required` without backend generation; omitted draft remains a compatibility path that may require provider credentials; no caller can select actor/mode/delegation state; live Path A demonstrates tested-client confirmation timing without claiming a universal noauth guarantee | T18, T20, T22, T23, T27, T28 | MCP schemas/handler + integration import + backend approval + live acceptance | supplied-draft direct-review/no-generation + compatibility-generation + approval-contract tests | T27 contract regressions + T28 client evidence |
| M09 | OAuth/DCR/session/static external bearer runtime/config/storage is removed; `delegated_e2e`/delegation grants are deferred and unreachable from active MCP contract | T23, T26 | `mcp/server.mjs`, `security/`, Compose/env/tests | dead-code/config search + route absence tests | exact-head CI + active-diff review |
| M10 | Anonymous edge exposure has finite defaults: rate 20/min and max 2 in-flight writes; active-project cap 3 is a durable global Bright Profile invariant, not a process-local counter | T17, T19, T20, T21, T24, T26 | MCP edge guards + backend transactional admission | rate/in-flight/create/retry/concurrent-admission regressions | T27 adversarial gate + T28 recorded values |
| M11 | Signed MP4 capability remains bound to project/revision/artifact with expiry/tamper checks, authoritative file validation, streaming/backpressure/timeout controls | T25 | `security/download-token.mjs`, artifact/integration routes, MCP proxy | token + download integration tests | T27 completed MP4 download |
| M12 | Runtime topology keeps app/worker private and MCP storage-isolated; T28 uses temporary HTTPS MCP ingress and closure requires both writes disabled and external MCP ingress withdrawn/verified unreachable | T26, T28 | Compose/reverse-proxy/runtime config | Compose checks + live setup/teardown record | exact-head CI + T28 mandatory teardown evidence |
| M13 | Deterministic and live acceptance match the keyless EvidenceBundle + complete-draft handoff and truthful noauth/review-acknowledgment semantics; docs/PR claims are updated only from observed evidence | T27, T28 | E2E tests, status/todo/traceability/PR body | supplied-draft contract regression + compatibility lifecycle E2E + live evidence record | T28 Path A + Path B + project-wide DoD |

## ChatGPT MCP Closure Audit Checklist

Before delivery under the reset contract:

- [x] Standalone T01-T16 closure ledger remains unchanged in substance and binding.
- [x] Noauth reset requirements have owner tasks.
- [x] Traceability file explicitly distinguishes frozen standalone and open MCP ledgers.
- [x] Active MCP runtime matches `noauth` rather than OAuth/static bearer fallback.
- [x] Private MCP -> app service auth remains fail-closed with minimum 16-character secret validation.
- [x] No-auth writes are disabled by default with a tested kill switch.
- [x] Rate/in-flight limits are finite and tested (20 req/min, 2 in-flight writes).
- [x] Active-project capacity is transactionally enforced at Bright Profile for new create and retry/reactivation (`BRIGHT_CHATGPT_MAX_ACTIVE_PROJECTS`).
- [x] Concurrent admissions cannot commit more active ChatGPT-origin projects than the configured cap.
- [x] Capacity rejection produces zero new project/job/attempt/reactivation mutation.
- [x] Approval is represented as external review acknowledgment, not authenticated human proof.
- [x] Any legacy stored `user_reviewed` value is documented/tested as compatibility data only.
- [x] OAuth/DCR/session runtime/config/storage is removed from the current milestone.
- [x] Delegated E2E is deferred and unreachable from active MCP contract.
- [x] Deterministic noauth E2E passes on exact implementation HEAD without claiming human-review proof.
- [x] Supplied-draft import reaches `review_required` without backend generation; omitted-draft generation is tracked only as compatibility coverage.
- [x] Full CI suite passes on pull request HEAD (verified via PR Checks/review evidence).
- [ ] Live ChatGPT noauth Path A supplies a complete draft, reaches direct `review_required` without backend generation, and shows the tested client waits for user confirmation.
- [ ] Live review-acknowledged completion Path B passes.
- [ ] T28 records write/ingress enable values.
- [ ] T28 restores `MCP_NOAUTH_WRITE_ENABLED=false`.
- [ ] T28 withdraws external MCP ingress and verifies the remote endpoint is no longer externally reachable.
- [x] Final docs and PR body match observed implementation and contract truth.
- [ ] Project-wide Definition of Done is checked.

Closure audit result: **OPEN — implementation and exact-head CI verification are complete; live ChatGPT acceptance and mandatory external-ingress teardown remain open for T28 live execution.**
