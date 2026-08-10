# Implementation Plan: Standalone Bright Profile Production App

**Source spec:** `docs/specs/standalone-production-app.md`  
**Spec approval:** Approved by the user before `/plan` on 2026-08-10  
**Target branch for planning artifacts:** `spec/standalone-production-app`  
**Implementation status:** Not started

## Goal

Replace n8n orchestration with a production-ready, single-VPS standalone internal app that supports:

```text
creator/topic + optional public URLs
  -> research
  -> normalized sources + provenance
  -> structured script/scene/voiceover draft
  -> human review/edit
  -> explicit approval snapshot
  -> media ingest
  -> Google TTS
  -> Remotion render
  -> MP4 download
```

The existing Remotion composition and timed Google TTS remain the execution core. The work should add durable orchestration, operator UI, provider adapters, security boundaries, and production operations around that core rather than rewrite it.

---

## Architecture Decisions Locked for Implementation

### 1. HTTP/application runtime

Keep Node.js ESM and the existing `node:http` approach. Add one small project-owned router/error layer instead of introducing Express/Fastify in the first milestone.

Rationale:
- the app is low-concurrency and internal;
- the repository already uses `node:http`;
- the required API is finite and resource-oriented;
- avoiding a web framework keeps the dependency surface small;
- JSON/body/schema validation remains explicit at trust boundaries.

### 2. Validation

Use shared JSON Schema documents for operator API payloads, provider outputs, approved revisions, and render manifests. Use Ajv as the runtime validator, pinned in `package-lock.json`.

The same generation-output JSON Schema should be passed to the LLM provider's structured-output API and validated again locally after the response is received. Provider compliance is not treated as a security boundary.

### 3. Durable state and queue

Use SQLite through `better-sqlite3`, with the dependency pinned to the verified stable release selected during build. At plan time the latest verified upstream release is `13.0.3` and declares Node `>=22` support.

Use:
- WAL mode;
- foreign keys;
- bounded busy timeout;
- explicit numbered migrations;
- short transactional writes;
- atomic job claim/update transactions;
- lease timestamps for stale-worker recovery.

Do not use Node 24's built-in `node:sqlite` for this milestone because the current Node 24 documentation still labels it Release Candidate rather than stable.

### 4. Job execution model

One `app` process and one `worker` process use the same SQLite/data volume.

The worker:
- polls for runnable durable stages;
- atomically claims one stage with a lease;
- renews the lease during long work;
- records attempt/stage/error data;
- stops claiming new work on graceful shutdown;
- recovers expired leases after restart;
- runs only one Remotion render at a time by default.

Research/generation may execute before approval. Media ingest, TTS, and render require an immutable approved revision.

### 5. Research provider

Initial provider: **OpenAI Responses API web search tool**, accessed through the official OpenAI JavaScript SDK.

Research behavior:
- OpenAI web search is discovery only;
- retain URLs surfaced by web-search call source metadata/citations;
- operator-provided URLs enter the same normalized source pipeline;
- the application-owned safe fetcher retrieves publicly reachable source content where allowed;
- inaccessible sources are stored with an unavailable/failed status;
- search/provider text is untrusted and cannot create privileged actions.

The production model ID is configuration, not a floating `latest` alias. Before production, pin an explicit model snapshot after the provider eval smoke passes.

### 6. Generation provider

Initial provider: **OpenAI Responses API structured output**.

Generation behavior:
- generation receives only normalized source records/approved operator context, not unrestricted browsing capability;
- request a strict JSON-schema output containing claims, source IDs, script, voiceover chunks, and Remotion scene plan;
- reject output when local schema validation fails;
- reject supported claims referencing unknown source IDs;
- classify incomplete/timeout/rate-limit/provider errors into stable retryable/non-retryable application errors;
- bound retries, output tokens, and request duration;
- never log full prompts/responses by default.

The official OpenAI JS SDK is pinned in the lockfile. At plan time, the latest verified release is `7.4.0` (2026-08-03); `/build` must re-check official docs/release notes before installing if the repository has moved forward.

### 7. Public URL and media fetch policy

Implement one application-owned HTTP(S) fetch module with manual redirect handling using Node core HTTP/HTTPS primitives.

Security properties:
- protocol allowlist: HTTP/HTTPS only;
- resolve hostname before connection;
- reject private/reserved/link-local/loopback/cloud-metadata destinations;
- validate each redirect destination again;
- bounded redirects/timeouts/body sizes;
- send `Accept-Encoding: identity` to avoid unbounded decompression paths in the MVP;
- never forward application/provider auth headers to fetched URLs;
- per-purpose MIME allowlists;
- safe generated local filenames.

The same policy is used by research URL retrieval and media ingest.

### 8. Frontend

Use existing React 19.1.0 with **Vite** and plain JavaScript.

Keep routing dependency-free for MVP using simple hash routes:
- `#/projects`
- `#/projects/:id`
- `#/projects/:id/review`

The built SPA is served by the app process. No Next.js, SSR framework, global state library, or component framework is required.

### 9. Operator authentication / TLS

Production ingress:

```text
Internet / operator browser
        |
      Caddy
        |
  oauth2-proxy
   (GitHub OAuth)
        |
       app
        |
   private Compose network
        |
      worker
```

Initial production components:
- Caddy `2.11.4` (latest verified at plan time) for TLS/reverse proxy;
- oauth2-proxy `7.15.3` (latest verified at plan time) using GitHub OAuth;
- restrict login to an explicit `GITHUB_ALLOWED_USERS` allowlist for the internal team;
- only Caddy publishes host ports 80/443;
- oauth2-proxy, app, and worker stay private;
- worker publishes no port;
- app accepts trusted identity headers only from the private proxy path;
- unsafe browser mutations require same-origin validation; CORS is not opened for arbitrary origins.

If no real hostname/DNS/OAuth callback can be configured yet, local implementation may run without the gateway, but the production readiness gate remains blocked.

### 10. Metrics/logging

- Structured JSON logs to stdout/stderr; no extra logging framework initially.
- Generate/propagate `requestId`, `projectId`, `jobId`, stage, attempt, and duration fields.
- Prometheus-format `/metrics` endpoint using a small pinned metrics dependency (`prom-client`) unless implementation proves a no-dependency exposition is simpler and equally testable.
- `/health/live` is process-only.
- `/health/ready` checks SQLite/data-dir readiness without making expensive live provider calls.

### 11. Retention and disk defaults

Defaults are configurable environment settings:
- completed heavy artifacts/final MP4: 30 days;
- failed/cancelled/unapproved transient artifacts: 7 days;
- project metadata, source metadata, and approved revision manifests: retained until explicit project deletion/administrative cleanup;
- warning threshold: less than 25% free disk;
- hard guard: do not start new media-ingest/TTS/render work when free disk is below either 15% or 20 GiB, whichever threshold is more conservative for the host.

Cleanup never removes active job files or the current approved revision manifest.

### 12. Testing/tooling

- Unit/integration runner: Node built-in `node:test`.
- Lint: ESLint with repository ESM/JS conventions.
- Browser/UI tests: lightweight component/API integration where possible; the milestone does not add a heavy browser E2E framework unless manual/browser verification proves insufficient.
- CI provider calls use deterministic fakes; live OpenAI calls are manual/gated.
- Keep a real low-cost Remotion/Chromium/FFmpeg smoke render.

---

## Dependency Graph

```text
T01 Tooling/test foundation
 |
 +--> T02 Domain contracts/schemas
       |
       +--> T03 SQLite store/migrations
       |     |
       |     +--> T04 Durable job leasing/recovery
       |     |      |
       |     |      +------------------------------+
       |     |                                     |
       |     +--> T09 Research API slice           |
       |                                            |
       +--> T05 Safe URL/fetch policy               |
       |     |                                      |
       |     +--> T06 Provider contracts/fakes      |
       |           |
       |           +--> T07 OpenAI research adapter |
       |           +--> T08 OpenAI generation adapter
       |                    |                       |
       +--------------------+--> T09 Research slice |
                                |
                                +--> T10 Generate/review/approve
                                      |
                                      +--> T11 Media ingest
                                            |
                                            +--> T12 Render worker
                                                  |
                                                  +--> T13 Renderer hardening

T09 -----------------------> T14 UI create/status
T10 + T12 + T14 -----------> T15 UI review/completed
T04 + T12 -----------------> T16 Observability
T03 + T11 + T12 -----------> T17 Retention/backup/disk guard
T13 + T15 + T16 + T17 -----> T18 Production Compose/auth
T18 -----------------------> T19 CI/release/E2E/rollback gate
```

---

## Vertical Slices and Ordering

### Slice A — Foundation and hardest invariants

Tasks T01-T05.

Prove first:
- behavior can be regression-tested;
- workflow states are explicit;
- SQLite persistence/migrations work;
- durable jobs survive a simulated worker restart;
- all future remote fetching has one SSRF-safe boundary.

This is risk-first because the current in-memory queue and remote-URL behavior are the largest production blockers.

**Checkpoint A:** stop if durable leasing/recovery or safe redirect/DNS policy cannot be demonstrated with tests.

### Slice B — Topic to research/draft without UI

Tasks T06-T10.

Deliver an API-driven path:

```text
POST project
 -> research
 -> stored normalized sources
 -> generation
 -> persisted review-required draft
 -> approval gate
```

Provider interfaces are tested with fakes first. Live OpenAI adapters are thin and independently replaceable.

**Checkpoint B:** prove claim provenance, invalid-source rejection, structured-output validation, and approval invalidation before building media/render/UI on top.

### Slice C — Approved revision to deterministic MP4

Tasks T11-T13.

Deliver:

```text
approved revision
 -> safe local media ingest
 -> timed Google TTS
 -> Remotion render
 -> validated output.mp4
```

Renderer changes stay scoped to trusted-local asset behavior and removal of normal-path `disableWebSecurity: true`.

**Checkpoint C:** a controlled approved fixture renders correctly using only trusted local/application-controlled media.

### Slice D — Standalone operator experience

Tasks T14-T15.

Deliver the browser workflow without raw JSON editing:
- create project;
- monitor stages/errors;
- inspect sources/claims;
- edit draft;
- approve;
- render/retry/cancel where safe;
- download completed MP4.

**Checkpoint D:** keyboard walkthrough and API/UI smoke of the full human approval workflow.

### Slice E — Production operations

Tasks T16-T19.

Add:
- structured logs/metrics/health;
- disk guard, retention, backup;
- Caddy + GitHub OAuth gateway;
- n8n-free Compose topology;
- CI quality gates;
- deploy/rollback docs;
- controlled restart/recovery E2E verification.

**Final checkpoint:** project-wide Definition of Done plus the spec's 15 success criteria.

---

## Parallelization Opportunities

After T02 is merged:
- T03 SQLite store and T05 URL policy can proceed independently.

After T06 is merged:
- T07 research provider and T08 generation provider can proceed independently because they share only the provider contract.

After T09/T10 contracts stabilize:
- T14 UI create/status can proceed while T11/T12 render execution is being built.

After T12:
- T16 observability and T17 retention/backup can proceed independently with coordination on job/state fields.

Must remain sequential:
- migrations before code requiring migrated tables;
- approval snapshot before media/TTS/render;
- media ingest before renderer security hardening is considered complete;
- production Compose/auth before final deployment E2E.

---

## API Contract Refinement

Keep the spec's observable operations, grouped under one project resource. Proposed implementation endpoints:

```text
POST   /api/projects
GET    /api/projects
GET    /api/projects/:id
POST   /api/projects/:id/research
POST   /api/projects/:id/generate
PATCH  /api/projects/:id/draft
POST   /api/projects/:id/approve
POST   /api/projects/:id/render
POST   /api/projects/:id/retry
POST   /api/projects/:id/cancel
GET    /api/projects/:id/sources
GET    /api/projects/:id/artifacts/output
GET    /health/live
GET    /health/ready
GET    /metrics
```

State-changing endpoints:
- validate JSON body with shared schemas;
- reject invalid transitions with stable `409` application errors;
- reject unauthorized/untrusted proxy paths in production;
- use the approved immutable revision ID for render requests.

No endpoint allows arbitrary local filesystem paths, arbitrary shell commands, raw provider tool selection, or unvalidated URL fetches.

---

## Storage Model Direction

Initial schema should separate mutable drafts from immutable approved snapshots.

Expected tables/concepts:

```text
schema_migrations
projects
sources
project_sources
revisions
revision_claims
revision_source_refs
jobs
job_attempts
artifacts
```

Important invariants:
- one project may have many draft/approved revisions;
- approved revision payload/hash is immutable;
- jobs refer to a project and, where required, an approved revision;
- job claim is atomic and lease-based;
- source IDs are application-owned and stable;
- artifacts have safe relative paths and provenance metadata;
- DB never stores secrets or provider auth tokens.

Use additive migrations first. No destructive migration is needed for the first standalone milestone because the current file-backed state is not treated as a production database contract.

---

## Security Threat Boundaries

### Boundary 1: Browser/operator -> app

Controls:
- GitHub OAuth via oauth2-proxy;
- private upstream network;
- JSON schema validation;
- same-origin mutation checks;
- body limits;
- stable sanitized errors.

### Boundary 2: Public URL/search result -> safe fetcher

Controls:
- canonical SSRF policy;
- DNS/IP validation;
- redirect revalidation;
- response size/MIME/time bounds;
- no secret forwarding.

### Boundary 3: Public content -> OpenAI generation

Controls:
- delimit/structure source records as data;
- no provider/tool permissions derived from source text;
- token/input limits;
- source IDs assigned by application.

### Boundary 4: Model output -> application

Controls:
- strict JSON schema requested;
- local Ajv validation;
- source-ID referential validation;
- scene/timeline/render bounds;
- no model-selected URLs fetched without safe-fetch validation.

### Boundary 5: Approved revision -> worker/renderer

Controls:
- immutable revision hash/ID;
- approved media pre-ingested locally;
- safe artifact paths;
- render concurrency/resource limits;
- no arbitrary remote URLs in normal render path.

---

## Verification Strategy

During implementation, every behavioral task uses RED -> GREEN -> REFACTOR with focused Node tests.

Required evidence by final gate:

```text
npm ci
npm run lint
npm test
npm run build
npm run smoke:render
npm run smoke:api
docker compose config
docker compose build
```

Production/staging verification additionally demonstrates:
- login via configured GitHub allowlist;
- create -> research -> generate -> review -> approve -> render -> download;
- restart worker while a durable stage is claimed and observe lease recovery;
- restart app without losing project state;
- SSRF tests for loopback/private IP/redirect-to-private targets;
- no normal render dependency on arbitrary remote URLs;
- low-disk guard blocks expensive new work;
- backup command produces a restorable SQLite/manifest backup;
- liveness/readiness/metrics/logs are observable;
- rollback to previous immutable image tag succeeds or is rehearsed with exact commands.

Live OpenAI provider checks are manual/gated and must never be required for deterministic PR CI.

---

## Main Risks and Mitigations

### Web/social availability

Risk: public TikTok/Facebook/Instagram/Threads/X pages are not reliably fetchable by generic HTTP clients.

Mitigation: use web-search discovery, preserve unavailable status, allow operator-provided URLs, never bypass access controls, and require human review. The milestone does not promise that every listed platform page can always be downloaded.

### Provider variability/cost

Risk: LLM/search output and pricing/limits change.

Mitigation: provider interfaces, explicit model configuration, production snapshot pinning, bounded retries/tokens, deterministic fake-provider tests, and a small manual provider eval before release.

### SQLite contention

Risk: app and worker share a single file DB.

Mitigation: short transactions, WAL, busy timeout, single render worker, no large blobs in SQLite, and indexes on runnable-job queries. If measured contention becomes unacceptable, changing to PostgreSQL/Redis remains an explicit future architecture decision rather than premature MVP complexity.

### Resource exhaustion

Risk: Chromium/FFmpeg/media can exhaust CPU/RAM/disk.

Mitigation: separate worker, concurrency 1, Compose limits, bounded duration/scenes/media, disk guard, artifact retention, and stage metrics.

### Auth configuration drift

Risk: GitHub OAuth callback/allowlist/TLS configuration can be misconfigured.

Mitigation: pinned gateway images, `oauth2-proxy --config-test` where applicable, Compose config validation, private upstreams, explicit `.env.example`, and deployment smoke login.

---

## Scope Guardrails

Do not add during this milestone unless separately approved:
- PostgreSQL, Redis, Kubernetes, object storage;
- multi-tenant accounts/roles/billing;
- private/authenticated social scraping;
- automatic posting to social networks;
- generalized workflow engine;
- a new Remotion design system or large scene rewrite;
- multiple render workers/hosts;
- speculative plugin architecture beyond the two provider boundaries already required.

---

## Final Definition of Done Gate

Before declaring `/build` complete, verify both task acceptance criteria and the project-wide Definition of Done:

- correctness: requested behavior and error paths work at runtime;
- tests: new behavior is regression-covered and relevant suites pass;
- quality: no unrelated refactor/dead debug code;
- integration: app/worker/SQLite/artifact/provider/render paths work together;
- documentation: README, env, operations, API behavior, and rollback reflect current truth;
- security: auth, SSRF, provider/model validation, secret handling, dependency audit are reviewed;
- observability: critical job stages have logs/metrics/health evidence;
- ship readiness: reproducible image, migration/backup, smoke, and rollback evidence exist.

Implementation must stop and surface evidence if any required gate cannot be verified rather than marking the work complete by assumption.
