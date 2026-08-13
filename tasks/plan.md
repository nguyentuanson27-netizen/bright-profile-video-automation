# Implementation Plan: Standalone Bright Profile Internal MVP

**Primary scope:** `docs/project-status.md` and `docs/specs/standalone-internal-mvp-amendment.md`  
**Historical detail:** `docs/specs/standalone-production-app.md` where not superseded  
**Target branch:** `spec/standalone-production-app`  
**Plan status:** Ready for human review  
**Implementation status:** Not started for the standalone MVP

## Goal

Build the smallest internal standalone application that removes n8n/manual project-JSON orchestration from the supported creator-profile workflow:

```text
creator/topic + optional public URLs
  -> public-source research
  -> normalized/deduplicated evidence
  -> structured claims/script/voiceover/scene draft
  -> human review/edit
  -> explicit approval snapshot
  -> approved media ingest
  -> Google TTS
  -> Remotion render
  -> MP4 download
```

The current Remotion renderer, Google TTS integration, Bright Evidence normalizer, MCP deployment, and existing tests are foundations to reuse rather than rewrite.

The milestone is complete when one internal operator can run the flow above without n8n and without manually constructing render JSON, while project/job state survives supported process/container restarts.

## Explicit non-goals

Do not add in this milestone unless the user changes scope:

- public/commercial launch work;
- public SaaS, multi-tenancy, billing, roles, or signup;
- Codex-specific plugin work or ChatGPT desktop repo-marketplace acceptance;
- public Plugins Directory submission or legal/listing pages;
- Kubernetes, Redis, PostgreSQL, object storage, or multi-host workers;
- private/authenticated social scraping or access-control bypass;
- automatic posting to social networks;
- broad Remotion redesign or new scene system;
- production SLO/metrics platform, OAuth gateway, or public ingress hardening not required by the actual internal deployment.

Security controls still apply where real trust boundaries exist: external URLs, model output, MCP/API input, secrets, artifacts, and any endpoint intentionally exposed outside localhost/trusted networking.

## Current baseline to preserve

Already implemented and verified before this plan:

- Remotion `BrightCreatorProfile` render core and supported scene types;
- Google Cloud TTS integration;
- H.264 MP4 render path through Chromium/FFmpeg;
- current API-key protected render job/status/download baseline;
- Bright Evidence deterministic normalizer under `lib/evidence/`;
- read-only MCP wrapper and remote ChatGPT connectivity;
- observed live `normalize_evidence` call returning a structured `EvidenceBundle` with duplicate removal;
- Node `node:test`, ESLint, MCP verification CI, render smoke, Compose/Docker checks.

Known gaps that this plan addresses:

- current render API still uses an in-memory queue;
- current `compose.yml` still depends on the n8n Docker network;
- no durable project/revision/job database;
- no standalone research/generation/review orchestration;
- no operator UI for the end-to-end flow;
- renderer normal path still uses `chromiumOptions.disableWebSecurity: true`.

## Architecture decisions

### 1. Runtime: keep Node.js ESM and project-owned HTTP code

Keep Node.js ESM and the existing `node:http` style. Add a small application router/service layer rather than introducing Express/Fastify.

Reason: the app is internal, the route surface is finite, and explicit boundary validation keeps dependencies and migration scope small.

### 2. Durable state: SQLite on the existing persistent data volume

Use SQLite via `better-sqlite3`, selected and pinned during build after verifying current Node 24 compatibility from upstream documentation.

Required properties:

- explicit numbered migrations;
- WAL mode, foreign keys, bounded busy timeout;
- parameterized statements;
- short transactions;
- immutable approved revisions;
- durable jobs/stages with lease expiry, heartbeat renewal, bounded retries, and per-claim fencing tokens so stale owners cannot commit after reclaim.

Large source/media/render blobs stay on the filesystem, not in SQLite.

### 3. Reuse the Bright Evidence normalizer directly inside the standalone app

The standalone pipeline must call the existing `lib/evidence` normalization code **in-process**. It must not depend on the remote MCP endpoint or ChatGPT UI to normalize evidence.

The remote MCP remains a separate ChatGPT integration surface over the same deterministic normalization behavior.

This keeps one normalization implementation and avoids a network dependency inside the app.

### 4. Research provider: OpenAI Responses API web search

Initial research provider: official OpenAI JavaScript SDK + Responses API web search.

Official OpenAI documentation was re-checked on 2026-08-13 and still supports the `web_search` built-in tool in `responses.create`.

Research responsibilities:

- discover public sources and citation/source metadata;
- merge operator-supplied public URLs into the same candidate pipeline;
- treat all search/page content as untrusted data;
- produce atomic evidence candidates with provenance;
- pass candidates to the existing deterministic normalizer;
- preserve unavailable/inaccessible sources rather than fabricate replacements.

Normal CI uses deterministic fakes; live OpenAI calls are manual/gated.

### 5. Generation provider: OpenAI Responses API structured output

Initial generation provider: official OpenAI SDK + Responses API Structured Outputs.

Official OpenAI documentation was re-checked on 2026-08-13 and supports JSON-schema structured responses via the Responses API. `/build` must still re-check the exact pinned SDK/API syntax before implementation.

Generation receives only application-owned normalized evidence/source records and operator context. It does not browse independently.

Returned claims/script/voiceover/scene plan must be validated locally with the shared Ajv schema before persistence.

Generation itself is a durable worker stage. The HTTP generate action only enqueues/requests the stage; it does not own the long provider call. The durable transition is `research_ready -> generating -> review_required`, with provider attempts/retryable failures persisted and the final validated draft committed only by the current fenced stage owner.

### 6. Application and worker are separate processes over the same durable store

Use one HTTP/app process and one worker process.

The app:

- serves the internal operator UI and API;
- validates input and persists state;
- enqueues durable stages;
- never blocks an HTTP request on research, generation, TTS, or rendering.

The worker:

- atomically claims runnable stages using a unique claim/attempt token;
- renews/heartbeats leases while long-running work is still owned;
- records attempt/lease/error state;
- fences progress, terminal state, draft creation, and artifact registration/promotion against the current claim token so a stale worker cannot commit after lease loss/reclaim;
- recovers expired work after restart or worker loss;
- runs research, generation, TTS, and render through the same durable stage mechanism;
- runs render concurrency 1 by default;
- consumes immutable approved revisions for media/TTS/render work.

### 7. Human approval remains the gate before expensive/output-producing work

Research and draft generation may run automatically.

Media ingest, TTS, and render require an immutable approved revision. Editing factual claims, script, scene plan, media selection, or render settings after approval invalidates the approval and returns the project to `review_required`.

### 8. One safe HTTP(S) fetch boundary for public URLs and media

All application-owned remote HTTP(S) fetches use one safe-fetch module with:

- HTTP/HTTPS allowlist;
- explicit rejection of URL-embedded credentials (`username` / `password`);
- application-controlled DNS resolution for every request attempt;
- private/reserved/link-local/loopback/cloud-metadata rejection before connect;
- a check-to-connect invariant: the outbound socket connects only to an IP address that was resolved and validated for that exact attempt, with no fresh/default hostname lookup allowed to choose a different address after validation;
- preservation of the original hostname for HTTP `Host` and HTTPS SNI/certificate validation while the socket is pinned to the validated IP;
- independent re-resolution, re-validation, and validated-IP connection pinning for every redirect hop;
- timeout/size/MIME limits;
- no secret/auth-header forwarding;
- generated local filenames for downloaded artifacts.

No renderer/browser setting is treated as an SSRF control.

### 9. Render only approved local/application-controlled media on the normal path

Approved remote media is ingested before render. The normal render manifest references local/application-controlled assets only.

After that path is proven, remove `chromiumOptions.disableWebSecurity: true` from the default Remotion render path and keep existing scene behavior covered by smoke tests.

### 10. Minimal React/Vite operator UI, no browser auth subsystem in the MVP

Use existing React with Vite and plain JavaScript.

Screens:

- project list/create;
- project status/research progress;
- review/edit/approve;
- render status/completed download.

No raw JSON editing is required for normal use.

The internal MVP does not add a new browser authentication system. The app is private/loopback by default. If it is later exposed beyond trusted networking, authenticated/TLS ingress becomes a separate explicit task before exposure.

### 11. Compose target: n8n-free, internal, reversible

Final MVP Compose runs app + worker with the existing persistent data/artifact volume and no dependency on `n8n-docker_n8n-network`.

The app should publish to loopback/private networking by default. The worker publishes no port.

MCP deployment remains separate and unchanged unless a later task explicitly requires integration changes.

## Dependency graph

```text
T01 Config/dependency foundation
  |
  +--> T02 Domain + schema contracts
         |
         +--> T03 SQLite persistence
         |      |
         |      +--> T04 Durable jobs/leases/renewal/fencing
         |
         +--> T05 Safe URL fetch boundary
                |
                +--> T06 Research service + provider fakes + normalizer reuse
                       |
                       +--> T07 OpenAI web-search adapter
                              |
T03 + T04 + T05 + T07 ------> T08 Research API vertical slice
                                      |
                                      +--> T09 Durable structured generation stage
                                             |
                                             +--> T10 Review + approval API
                                                    |
                                                    +--> T11 Approved media ingest
                                                           |
T04 + T11 -----------------------------------------------> T12 Durable TTS/render worker
                                                               |
                                                               +--> T13 Renderer trusted-local hardening

T08 -------------------------------> T14 UI create/status
T10 + T12 + T14 -------------------> T15 UI review/approve/completed
T03 + T04 + T12 + T13 + T15 ------> T16 n8n-free Compose + deterministic E2E/restart gate
```

## Vertical slices

### Slice A — Durable foundations

Tasks T01-T05.

Prove the hardest invariants first:

- config/dependencies are deterministic;
- project lifecycle/contracts are explicit;
- state survives process reopen;
- job claims recover after simulated worker failure;
- long-running claims renew leases and stale owners are fenced from progress/final/artifact commits after reclaim;
- every future remote fetch goes through one SSRF-safe boundary whose validated DNS result is the address actually used to connect.

**Checkpoint A:** stop if SQLite persistence/lease recovery, heartbeat/fencing stale-owner regression, safe-fetch redirect/DNS policy, DNS-rebinding/check-to-connect regression, or credential-bearing URL rejection is red.

### Slice B — Creator/topic to normalized research

Tasks T06-T08.

Deliver an API-driven slice:

```text
create project
  -> enqueue research
  -> provider discovery/operator URLs
  -> atomic evidence candidates
  -> existing Bright Evidence normalizer in-process
  -> persisted research_ready project
```

**Checkpoint B:** with fake providers, restart the app/worker and confirm the project and normalized evidence survive. Then run one optional live OpenAI research smoke.

### Slice C — Research to approved immutable draft

Tasks T09-T10.

Deliver:

```text
research_ready
  -> enqueue generation
  -> generating
  -> durable worker + structured generation provider
  -> persisted review_required draft
  -> edit
  -> explicit approval
  -> immutable approved revision
```

**Checkpoint C:** prove generation restart/expired-lease recovery produces exactly one persisted draft, stale generation owners cannot finalize after reclaim, unknown source references are rejected, unverified claims block approval unless explicitly overridden, and post-approval edits invalidate approval.

### Slice D — Approved revision to valid MP4

Tasks T11-T13.

Deliver:

```text
approved revision
  -> safe media ingest
  -> durable TTS stage
  -> durable render stage
  -> validated output.mp4
```

**Checkpoint D:** render a controlled approved fixture using only trusted local/application-controlled assets; demonstrate lease renewal/recovery/fencing, prevent stale attempts from promoting/registering final artifacts, and remove default `disableWebSecurity` dependency.

### Slice E — Operator experience and n8n removal

Tasks T14-T16.

Deliver the full internal workflow without raw JSON or n8n:

```text
browser
  -> creator/topic
  -> research
  -> review/edit/approve
  -> render
  -> download MP4
```

**Final checkpoint:** deterministic E2E with fake providers, real local render smoke, app restart persistence, worker lease renewal/recovery/fencing, n8n-free Compose, and project-wide Definition of Done.

## Task summary

| Task | Outcome | Depends on | Scope |
|---|---|---|---|
| T01 | Config/tooling/dependencies ready for standalone build | None | M |
| T02 | Domain lifecycle and shared schemas | T01 | M |
| T03 | SQLite migrations and repositories | T02 | M |
| T04 | Durable jobs, lease renewal/fencing, retry/recovery | T03 | M |
| T05 | Canonical SSRF-safe fetch boundary | T02 | M |
| T06 | Research service, fakes, direct evidence-normalizer reuse | T02,T05 | M |
| T07 | OpenAI Responses web-search adapter | T06 | M |
| T08 | Create/research API vertical slice | T03,T04,T05,T07 | M |
| T09 | Durable structured generation worker stage | T04,T06,T08 | M |
| T10 | Draft review/edit/approval API | T03,T09 | M |
| T11 | Approved media ingest/artifact records | T05,T10 | M |
| T12 | Durable TTS/render worker with fenced artifact finalization | T04,T11 | M |
| T13 | Trusted-local Remotion boundary | T11,T12 | M |
| T14 | React/Vite create/status UI | T08 | M |
| T15 | Review/approve/render/download UI | T10,T12,T14 | M |
| T16 | n8n-free Compose + deterministic E2E/restart gate | T03,T04,T12,T13,T15 | M |

Detailed acceptance criteria and verification commands live in `tasks/todo.md`.

## API direction

Keep a small resource-oriented internal API:

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
```

Long-running state-changing actions such as research, generation, TTS, and render enqueue/transition durable stages and return without owning the provider/render work in the HTTP request. State-changing endpoints validate JSON schemas and lifecycle transitions. Errors return stable sanitized JSON with a request ID. No endpoint accepts arbitrary local filesystem paths, shell commands, provider tool selection, or unvalidated remote URLs.

## Storage direction

Expected SQLite concepts:

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

Key invariants:

- project/source/job state survives reopen;
- approved revision content/hash is immutable;
- jobs refer to project and approved revision where required;
- each runnable claim has a current owner/attempt fencing token and lease expiry;
- lease renewal, progress, completion, draft creation, and artifact registration/promotion require the current fencing token; a reclaimed/stale owner is rejected even if it later resumes;
- source IDs are application-owned;
- artifacts store safe relative paths and provenance;
- secrets/provider tokens are never stored in project records.

## Verification strategy

Every behavioral implementation task follows RED -> GREEN -> REFACTOR.

Normal PR verification should be deterministic and avoid paid/live provider calls.

Expected final commands after the relevant tasks add them:

```text
npm ci
npm test
npm run lint
npm run build
npm run render:smoke
npm run db:migrate -- --database <temp-db>
docker compose config
```

Final runtime evidence must additionally cover:

- create -> research -> generate -> review -> approve -> render -> download with deterministic fake providers;
- one gated live OpenAI research smoke and one gated structured-generation smoke when credentials are available;
- app restart without project-state loss;
- simulated worker death and expired-lease recovery;
- lease heartbeat/renewal for long-running work plus a stale-owner fencing regression where worker B reclaims a stage and worker A is then unable to commit progress/final state/artifacts;
- generation restart/lease recovery from `generating` to exactly one `review_required` draft with persisted provider attempt/failure state and no duplicate draft/revision creation;
- SSRF rejection for direct private targets, redirect-to-private targets, DNS rebinding/check-to-connect changes, and credential-bearing URLs;
- deterministic proof that a blocked address is never connected to after a different address was validated for the same attempt;
- approved-media path traversal/type/size failures;
- output MP4 existence/non-zero/ffprobe validation;
- normal render path without arbitrary remote media or default `disableWebSecurity`;
- Compose contains no n8n network dependency;
- direct existing MCP tests remain green even though the standalone app does not depend on MCP transport.

## Main risks and mitigations

### Public social-source availability

Some public TikTok/Facebook/Instagram/Threads/X pages may not be reliably fetchable through generic HTTP access.

Mitigation: web-search discovery, operator URLs, explicit unavailable status, alternative public sources, no access-control bypass, and human review.

### Model/provider variability

Research/generation can vary or fail due to rate limits, incomplete responses, pricing/model changes, or malformed output.

Mitigation: narrow provider interfaces, deterministic fakes, strict local schemas, explicit model config, bounded retries/timeouts/tokens, durable attempt state, lease renewal/fencing, and manual live smoke outside normal CI.

### SQLite contention/recovery

App and worker share one DB.

Mitigation: short transactions, WAL, busy timeout, indexed runnable-job queries, one render worker, lease-based claims with heartbeat renewal and fencing tokens on all state/artifact commits. Do not introduce Redis/PostgreSQL unless measured evidence shows SQLite cannot meet this single-host internal use case.

### Renderer/resource pressure

Chromium/FFmpeg/media can consume CPU/RAM/disk.

Mitigation: render concurrency 1, current duration/scene bounds, bounded media ingest, per-attempt partial-output isolation, fenced final artifact promotion, and explicit output validation. Broader production capacity planning is out of scope.

### Scope creep back into plugin/deployment work

Mitigation: Bright Evidence MCP is already accepted for current ChatGPT use. Do not make plugin/Codex/marketplace/public-launch work part of standalone completion.

## Parallelization

Safe after contracts stabilize:

- after T02: T03 and T05 can proceed independently;
- after T06: T07 can proceed while T03/T04 finish;
- after T08: T14 UI create/status can proceed while T09/T10 are built;
- after T10: T11 can proceed while T14 UI work continues.

Must remain sequential:

- migrations before repositories/jobs that require them;
- durable generation completion before review/approval;
- approval before media/TTS/render;
- media ingest before trusted-local renderer hardening can be considered complete;
- T16 only after the full application path exists.

## Final Definition of Done gate

The standalone internal MVP is complete only when task acceptance criteria and the project-wide Definition of Done both pass:

- requested internal workflow works at runtime;
- new behavior has regression tests and existing MCP/render tests stay green;
- no unrelated refactor or dead compatibility code remains;
- app/worker/SQLite/artifact/provider/render paths integrate correctly;
- docs describe current truth;
- external input/model output/secrets/artifact boundaries are reviewed;
- restart/retry behavior is demonstrated, including long-stage lease renewal and stale-owner fencing after reclaim;
- generation is demonstrably durable across worker/process restart without duplicate drafts;
- no n8n dependency or manual project JSON is required for the normal operator flow.

## Human gate

This plan is ready for review. Do not start `/build` until the user approves this revised plan.