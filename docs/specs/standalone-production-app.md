# Spec: Standalone Bright Profile Production App

**Status:** Draft for human review  
**Branch:** `spec/standalone-production-app`  
**Scope:** Replace n8n orchestration with a standalone internal application while retaining the existing Remotion rendering and Google TTS core.

## Assumptions

1. Production runs on one VPS/host using Docker Compose.
2. The first release serves one operator or a small internal team, not public multi-tenant SaaS users.
3. The primary workflow starts from a creator name/topic plus optional public URLs and ends with a downloadable MP4.
4. Research may use public web search and public URLs from websites and social platforms including YouTube, TikTok, Facebook, Instagram, Threads, and X. The application must not authenticate into private social accounts, bypass access controls, or depend on private scraping.
5. A human review checkpoint is mandatory before TTS/rendering.
6. Existing Remotion scene rendering and Google TTS remain the execution core unless implementation evidence shows a blocking limitation.
7. Research/search and LLM generation are provider interfaces. The first concrete providers will be selected during `/plan`; this spec defines their contracts and safety requirements rather than silently choosing a vendor.
8. Local persistent storage is acceptable for the single-host MVP. Job/workflow state must be durable across process/container restarts.

---

## Objective

Build a standalone internal web application that lets an operator enter a creator/topic and optional public source URLs, then automatically:

1. research the creator/topic from public sources;
2. extract traceable factual claims and candidate media;
3. generate a script and Remotion-compatible scene plan;
4. present research, sources, script, and scene plan for human review/editing;
5. require explicit approval;
6. ingest approved media into local job storage;
7. generate timed voiceover with Google TTS;
8. render the approved project with the existing Remotion composition;
9. expose progress, errors, logs/status, and a final MP4 download;
10. survive application/worker restart without losing durable job state or leaving work permanently stuck.

The application replaces n8n orchestration. It must not depend on an n8n Docker network, n8n workflow, n8n credentials, or n8n callbacks.

### Target user

An internal content operator or small internal team producing creator-profile videos.

### Primary user story

> As an operator, I enter a creator name/topic and optional public URLs, let the app research and draft the video, review and edit the factual claims/script/scenes, approve the revision, and receive a rendered MP4 without using n8n or manually constructing project JSON.

### Secondary user stories

- As an operator, I can see which source supports each factual claim.
- As an operator, I can see inaccessible/failed sources instead of having the system silently invent replacement facts.
- As an operator, I can edit the draft before approval.
- As an operator, I can retry a failed retriable stage without recreating the project from scratch.
- As an operator, I can return after a restart/redeploy and see the correct persisted state.
- As an operator, I can download the approved final video and inspect the approved manifest that produced it.
- As an operator/on-call engineer, I can determine which stage failed and why without exposing secrets or full untrusted source content in logs.

---

## Current Baseline to Preserve

The current repository already provides:

- Node.js ESM application code;
- Remotion `BrightCreatorProfile` composition at 1920x1080, 30 fps;
- reusable scene types including `hero`, `claim`, `vertical`, `source`, `social`, and `stats`;
- Google Cloud Text-to-Speech integration with timed chunks and FFmpeg fitting;
- H.264 MP4 rendering through Remotion/Chromium;
- Docker runtime with Chromium, FFmpeg, Noto fonts, healthcheck, and non-root `node` user;
- API-key protected job/status/download endpoints;
- existing SSRF-oriented blocking of localhost/private media URLs;
- file-backed job request/state/output directories;
- render smoke/API smoke scripts.

The implementation should wrap and harden these capabilities rather than rewrite the video renderer during the first standalone milestone.

---

## Tech Stack

### Existing, pinned by the repository

- Node.js 24 (`node:24-bookworm-slim` container baseline)
- JavaScript ESM
- React 19.1.0
- Remotion 4.0.484
- `@remotion/bundler` 4.0.484
- `@remotion/renderer` 4.0.484
- `@remotion/transitions` 4.0.484
- `@google-cloud/text-to-speech` 6.4.1
- Chromium
- FFmpeg/ffprobe
- npm with lockfile v3
- Docker / Docker Compose

### Required target architecture

- **Web/API process:** operator UI plus application API. It must not execute long render work on the HTTP request path.
- **Worker process:** claims durable jobs and executes research, generation, media ingest, TTS, and render stages. App and worker may use the same image with different entrypoints.
- **Durable state store:** SQLite-backed metadata/state is the preferred single-host MVP design. The exact Node SQLite library/API is selected in `/plan`; the observable contract in this spec is durable transactional state, not a particular package.
- **Persistent artifact store:** local filesystem/bind volume for source snapshots/approved media, TTS output, render intermediates, and final MP4 files.
- **Research provider adapter:** performs public search/discovery and returns normalized search/source records.
- **Generation provider adapter:** consumes normalized source records/claims and returns schema-validated structured output for facts, script, voiceover chunks, and scene plan.
- **Authenticated production gateway:** production access must be TLS-protected and authenticated. The app must not be directly exposed to the public internet without a gateway/auth boundary. Exact gateway/auth implementation is selected in `/plan`.

No Redis, PostgreSQL, Kubernetes, or multi-region infrastructure is required for the first single-host release unless the implementation plan proves SQLite/local storage cannot satisfy the acceptance criteria.

---

## Workflow and State Model

### Project lifecycle

A project progresses through explicit persisted states:

```text
draft
  -> researching
  -> research_ready
  -> generating
  -> review_required
  -> approved
  -> media_ingest
  -> tts
  -> render_queued
  -> rendering
  -> completed
```

Terminal/side states:

```text
failed
cancelled
```

A failed project/job records:

- failed stage;
- stable error code;
- sanitized operator-facing message;
- whether the stage is retryable;
- attempt count;
- timestamp;
- correlation/job ID.

### Revision/approval rule

Research results and generated drafts are editable. Approval creates an immutable **approved revision snapshot** containing:

- creator/topic input;
- selected sources and source IDs;
- factual claims and their source references;
- approved script;
- approved voiceover chunk timeline;
- approved scene plan;
- approved media selections;
- render settings.

TTS/rendering must consume the approved snapshot, not mutable draft data.

If the operator edits facts, script, scene plan, selected media, or render settings after approval, the project becomes `review_required` again and must be re-approved before another render.

---

## Research Requirements

### Inputs

Required:

- `topic`: creator name or creator-related topic.

Optional:

- public URLs supplied by the operator;
- short operator instructions/context;
- target video duration within existing renderer limits;
- language/voice preferences supported by configured TTS.

### Public source coverage

The system may discover or process public pages from:

- general websites/news/blogs;
- YouTube;
- TikTok;
- Facebook public pages/posts;
- Instagram public pages/posts;
- Threads;
- X;
- other publicly reachable HTTP(S) pages.

A platform being listed does **not** mean the system may bypass login walls, anti-bot controls, private APIs, robots/access controls, or technical restrictions. If public content cannot be fetched reliably through the configured provider/fetch path, the UI must mark it unavailable and continue with remaining evidence.

### Source normalization

Every retained source record must include at least:

- stable internal `sourceId`;
- canonical/original URL;
- platform/domain;
- title/label where available;
- retrieval timestamp;
- retrieval status;
- normalized text/metadata excerpt used for research;
- content hash or equivalent change-detection value where practical;
- source type (`search-result`, `page`, `social`, `operator-url`, etc.).

### Claim provenance

Generated factual claims must reference existing `sourceId` values. Model-generated URLs or citations that were not present in the normalized source set are invalid.

Each factual claim is either:

- **supported:** one or more source IDs attached; or
- **unverified:** explicitly marked as such.

The review UI must visually surface unverified claims. Final approval is blocked while unverified factual claims remain unless the operator explicitly overrides each claim and supplies a reason. Overrides are stored in the approved revision.

### External content trust boundary

Search results, fetched pages, social content, comments, metadata, captions, transcripts, and model outputs are untrusted data.

Instruction-like text inside external content must never override application/system policy, tool permissions, provider configuration, render limits, or operator approval requirements.

---

## URL Fetching and Media Ingest

### SSRF controls

All server-side user/model-influenced HTTP(S) fetches must use one canonical URL policy shared by research and media ingest.

Required controls:

- HTTP/HTTPS only;
- reject localhost and private/reserved/link-local destinations by default;
- validate DNS results before connecting;
- revalidate redirect destinations;
- bounded redirect count;
- connection and total request timeouts;
- response-size limits;
- bounded decompression;
- content-type allowlists appropriate to each fetch path;
- no forwarding of application secrets/auth headers to arbitrary remote hosts;
- no access to cloud metadata endpoints or internal Docker/private services.

`ALLOW_PRIVATE_MEDIA_URLS` is not a valid production default. Private access, if ever required, must be an explicit trusted deployment configuration with separate tests.

### Media determinism

Approved remote media must be downloaded into the project's persistent local artifact directory **before** TTS/render execution.

Render-time Remotion input should reference trusted local assets or application-controlled asset endpoints rather than arbitrary external URLs whenever possible.

The first production milestone should remove the need for `chromiumOptions.disableWebSecurity = true` in the normal render path. If a narrowly scoped compatibility exception remains, it must be documented, tested, and applied only to trusted local/application-controlled assets.

### Media validation

Before storing approved media:

- enforce maximum byte size;
- validate MIME/type and supported extension/content;
- reject unsupported or malformed payloads;
- generate safe local filenames independent of remote filenames;
- never treat remote content as executable code;
- store source provenance beside the local artifact.

---

## Generation Contract

The generation provider must return schema-validated structured data, not free-form text that downstream code parses heuristically.

Minimum output:

```js
{
  researchSummary: '...',
  claims: [
    {
      id: 'claim-1',
      text: '...',
      sourceIds: ['source-1'],
      status: 'supported'
    }
  ],
  script: '...',
  voiceover: {
    chunks: [
      {id: 'hero', start: 0, duration: 6, text: '...'}
    ]
  },
  project: {
    duration: 30,
    creatorName: '...',
    scenes: []
  }
}
```

Requirements:

- provider output is validated before persistence/use;
- scene types must belong to the renderer's supported scene set;
- scene time ranges must be valid and within project duration;
- duration/render scale/CRF bounds reuse or strengthen current server limits;
- IDs must be stable within the revision;
- generated source references must resolve to stored sources;
- generation failure cannot silently fall back to fabricated facts;
- provider calls have timeout, bounded retries, and configurable token/request limits;
- provider-specific raw responses must not be logged wholesale.

---

## Review UI

The internal web UI must support the complete workflow without requiring raw JSON editing.

### Create screen

- creator/topic input;
- optional public source URLs;
- optional short instructions;
- submit/start research.

### Project status screen

- current persisted stage;
- stage timestamps/durations;
- retry/cancel controls where safe;
- sanitized failure reason;
- source/research progress.

### Review screen

Must show and allow editing of:

- source list with clickable original URLs;
- factual claims with linked source IDs;
- supported/unverified status;
- script;
- voiceover chunks/timing;
- scene plan and scene type;
- selected media/source provenance;
- basic render settings already supported by the renderer.

Actions:

- save draft;
- regenerate the draft using the current source set;
- add/remove public source URLs and rerun research;
- approve revision;
- after approval, start render.

### Completed screen

- final status;
- final MP4 download;
- approved revision summary;
- rerender action using the same approved revision;
- clear error state if output file is missing/corrupt.

The UI must handle loading, empty, error, retry, and disabled/pending states and be keyboard usable.

---

## Durable Job Processing

The current in-memory queue is replaced by a persistent queue/state model.

Required behavior:

- app restart does not lose queued work;
- worker restart does not leave jobs permanently `processing`;
- a worker claims one job/stage atomically;
- stale claims/leases can be recovered safely;
- retryable stages have bounded retries with backoff;
- non-retryable validation/approval failures do not loop;
- render concurrency defaults to one on the single VPS unless measured capacity supports more;
- graceful shutdown stops claiming new work;
- an interrupted render may be retried from the immutable approved revision after cleaning/isolating partial output;
- repeated execution of a stage must not create inconsistent duplicated project state.

The queue/state schema must support future migration without destructive in-place changes during the same rollout that depends on them.

---

## API Contract

The UI should consume the same internal application API used by tests/automation.

Minimum resource-oriented surface:

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

Exact endpoint grouping may be refined in `/plan`, but the observable operations above must exist.

### Error shape

Application JSON errors use one predictable shape:

```js
{
  error: {
    code: 'SOURCE_FETCH_FAILED',
    message: 'A public source could not be fetched.',
    retryable: true,
    requestId: '...'
  }
}
```

Do not return internal stack traces, provider secrets, filesystem paths, raw SQL, or raw third-party/model payloads to the browser.

---

## Production Authentication and Network Boundary

The standalone app must not inherit n8n networking or use n8n as an authentication layer.

For the internal MVP:

- only an authenticated/TLS gateway may be publicly bound;
- the application and worker stay on a private Compose network;
- worker has no published port;
- machine/internal API access may continue to use a rotated `BRIGHT_API_TOKEN` where needed;
- browser code must not persist long-lived infrastructure/provider API keys in localStorage/sessionStorage;
- exact operator authentication mechanism is selected in `/plan` and must provide session/access revocation and login abuse protection appropriate to the chosen gateway/app boundary.

If no authenticated gateway/private-network access is configured, the production deployment is not considered ready to expose beyond localhost.

---

## Secrets and Configuration

Secrets include at least:

- Google Cloud credentials;
- research/search provider credentials;
- generation/LLM provider credentials;
- internal API/gateway secrets;
- operator authentication secrets.

Requirements:

- no real secrets committed to Git;
- `.env.example` contains placeholders only;
- production secrets mounted/injected at runtime and read-only where file-based;
- secret values never emitted to logs, API responses, approved manifests, or generated model prompts unless explicitly required by the provider transport;
- config validation runs at process startup and fails fast on missing/invalid required production configuration;
- production and test credentials are separate.

---

## Storage, Retention, and Recovery

Use one persistent host data root, mounted into app/worker with consistent ownership.

Logical layout:

```text
data/
  app.sqlite
  projects/
    <project-id>/
      sources/
      media/
      revisions/
      tts/
      renders/
      output.mp4
  backups/
```

Requirements:

- no generated artifacts stored inside the container writable layer as the only copy;
- database plus approved manifests/source metadata are backed up before schema migrations/deploys that can affect them;
- retention/cleanup is configurable;
- cleanup never deletes the active approved revision or currently running job files;
- disk usage is observable;
- low-disk conditions prevent starting new expensive render work before the host is exhausted;
- final output integrity is checked before marking `completed`.

Default retention duration is intentionally left configurable rather than hard-coded in this spec; the `/plan` phase must select a documented default and cleanup policy.

---

## Observability

### On-call questions the system must answer

1. Is the app accepting operator requests?
2. Is the worker alive and able to claim work?
3. Which stage is a project/job in, and how long has it been there?
4. Why did the most recent research/generation/TTS/render attempt fail?
5. Is queue depth, error rate, render time, provider latency, or disk pressure worsening?

### Structured logs

Use structured events with stable fields such as:

```js
{
  event: 'render.completed',
  requestId: '...',
  projectId: '...',
  jobId: '...',
  stage: 'rendering',
  durationMs: 123456,
  attempt: 1
}
```

Never log:

- API keys/tokens/passwords;
- Google credentials;
- full request auth headers;
- full fetched page/social content;
- full LLM prompts/responses by default;
- sensitive filesystem/credential paths unless operationally necessary and sanitized.

### Health/readiness

- `/health/live`: process event loop/server is alive; must not depend on external providers.
- `/health/ready`: app/worker dependencies required to perform work are usable (state store and required local filesystem; provider checks should be shallow/bounded rather than expensive live generation calls).

### Metrics

Expose/query at minimum:

- queue depth;
- active worker jobs;
- jobs completed/failed by stage;
- stage duration histograms/percentiles;
- research/generation provider request count, errors, and latency;
- render duration and failures;
- disk free/used percentage or equivalent host-visible signal.

The exact metrics transport/library is selected in `/plan`.

---

## Deployment and Operations

### Compose topology

Target production Compose stack:

```text
gateway/auth (or documented external equivalent)
        |
       app  ---- durable SQLite/data volume
        |
     private network
        |
      worker ---- Chromium / FFmpeg / Google TTS / provider APIs
```

There must be no external `n8n-network` dependency.

### Image/release requirements

- one reproducible application image may serve both app and worker roles;
- install dependencies from the committed lockfile using immutable/frozen semantics (`npm ci`), not an unconstrained production `npm install`;
- image runs as non-root;
- Chromium/FFmpeg/fonts remain explicitly installed and smoke-tested;
- release/image version must agree with application version/release metadata;
- production deploys use immutable version/commit tags rather than mutable `latest` only;
- previous known-good image tag remains available for rollback.

### Rollout

A deploy must:

1. back up durable metadata before schema migration when relevant;
2. pull/build the target immutable image;
3. run/verify migration in a backward-compatible manner;
4. start/update app and worker;
5. verify liveness/readiness;
6. run a non-destructive API/UI smoke check;
7. run a small/controlled render smoke when appropriate;
8. monitor new errors and stuck jobs;
9. keep documented rollback commands ready.

### Rollback

Rollback documentation must include:

- trigger conditions;
- exact Compose/image rollback command;
- database compatibility implications;
- how interrupted jobs are recovered;
- how rollback success is verified.

Destructive schema migration and code that requires the destruction must not ship atomically in one irreversible step.

---

## Commands

### Commands that exist today

```sh
npm run render:smoke
npm run render:project -- examples/sample-project.json data/output.mp4
node server.mjs
```

Existing README also documents:

```sh
node scripts/render-project.mjs examples/sample-project.json data/output.mp4
```

### Required standard commands after standalone implementation

The implementation must add/document repository-native scripts so these capabilities have one obvious command each:

```sh
npm ci
npm run dev
npm run start
npm test
npm run lint
npm run build
npm run smoke:render
npm run smoke:api
npm run db:migrate

docker compose build
docker compose up -d
docker compose ps
docker compose logs -f app worker
```

Names may only change during `/plan` if repository conventions justify it; README, CI, and deploy docs must use the same final commands.

---

## Project Structure

Preserve the existing renderer/TTS/video modules initially and add focused modules around them rather than combining the feature with an unrelated renderer rewrite.

Target logical structure:

```text
server.mjs                 # thin app entrypoint
worker.mjs                 # thin worker entrypoint
app/
  config.mjs               # validated configuration
  http/                    # routes, request parsing, error mapping
  services/                # application use cases/orchestration
domain/
  project.mjs              # project/revision/workflow contracts
  schemas.mjs              # boundary/provider schemas
  errors.mjs               # stable application error codes
storage/
  db.mjs                   # durable state access/migrations
  artifacts.mjs            # project artifact paths/retention
providers/
  research/                # provider interface + adapter(s)
  generation/              # provider interface + adapter(s)
security/
  url-policy.mjs           # shared SSRF/redirect/network policy
  auth/                    # gateway/app auth integration
lib/
  remotion-renderer.mjs    # existing rendering engine, hardened incrementally
  timed-google-tts.mjs     # existing TTS engine
video/                     # existing Remotion composition/scenes
web/                       # operator UI
tests/
  unit/
  integration/
  fixtures/
scripts/                   # smoke/render/migration/ops scripts
examples/
docs/
  specs/
  operations/
```

The exact directory migration is implementation detail. Do not move existing files merely to match this tree unless a task needs the boundary.

---

## Code Style

Follow the repository's existing JavaScript ESM conventions:

- ESM `import`/`export`;
- 2-space indentation;
- semicolons;
- single quotes for JavaScript strings unless JSX/escaping makes another form clearer;
- concise named helpers;
- explicit async boundaries;
- small modules with domain intent rather than generic utility dumping grounds.

Preferred boundary style:

```js
export async function approveProject({projectId, revisionId, actor}) {
  const revision = await revisions.get(projectId, revisionId);
  if (!revision) throw new AppError('REVISION_NOT_FOUND', 404);
  if (revision.unverifiedClaims.length > 0 && !revision.overrideAccepted) {
    throw new AppError('UNVERIFIED_CLAIMS', 409);
  }

  return revisions.approve({projectId, revisionId, actor});
}
```

Rules:

- do not trust provider/model/fetched data after initial parse; validate at boundaries;
- do not pass raw HTTP request/response objects into domain/provider modules;
- do not duplicate workflow transition rules in route handlers and workers;
- avoid new abstraction layers unless they isolate a real boundary (storage/provider/security/worker).

---

## Testing Strategy

The repository currently has smoke scripts but no declared automated test framework/script. The standalone implementation must add a real test command before behavior is considered complete.

### Unit tests

Cover:

- workflow state transitions;
- approval/revision invalidation;
- project/scene/provider schema validation;
- URL/SSRF policy, including redirects/private IP cases;
- error classification/retryability;
- retention/path safety helpers;
- source/claim provenance validation.

### Integration tests

Cover:

- create project -> persist -> reload;
- worker claim/lease/recovery after simulated restart;
- research/generation provider adapter contract using deterministic fakes;
- approval gate blocks unverified claims without override;
- approved snapshot remains immutable;
- media ingest stores only validated local artifacts;
- TTS/render job state transition with external boundaries stubbed/faked where appropriate;
- API auth/gateway trust boundary as implemented;
- API error shape and authorization.

### Render smoke

Keep a real Remotion/Chromium/FFmpeg smoke path using controlled local fixtures. It must render a short/low-cost video and verify:

- output exists;
- output is non-empty;
- ffprobe can read it;
- expected duration is within tolerance.

### End-to-end smoke

A production/staging smoke should prove:

```text
create -> research(fake/safe controlled source) -> generate -> review/approve -> TTS/render -> download
```

External provider tests in CI should use deterministic fakes by default; live-provider tests are optional/manual or separately gated to avoid flaky/costly PR checks.

### Test commands

Focused tests should be available during implementation, and the full required suite must run before merge/release. The exact runner is selected in `/plan`; using Node's built-in test runner is preferred if it meets the needs without unnecessary dependencies.

---

## CI Quality Gates

Add GitHub Actions (or repository-standard equivalent) because no workflow is currently version-controlled.

Required PR/main gates, ordered cheap-to-expensive:

1. lockfile/frozen install (`npm ci`);
2. lint/static checks;
3. unit tests;
4. integration tests;
5. build/package check;
6. controlled render smoke;
7. Docker image build;
8. dependency/security audit with findings triaged rather than auto-force-fixed.

Required gates block merge. Tests must not be skipped/disabled to make CI green.

---

## Boundaries

### Always do

- validate all operator, fetched-source, provider, and model data at trust boundaries;
- preserve source provenance through research -> claims -> approved revision;
- require human approval before expensive final media/TTS/render work;
- store workflow state durably;
- use immutable approved revision snapshots for render;
- run production work as non-root;
- use lockfile-based reproducible installs;
- keep secrets out of code/logs/browser storage;
- retain SSRF/private-network protections for every server-side URL fetch;
- use structured logs and correlation/project/job IDs;
- keep renderer/TTS behavior regression-covered when changing it;
- keep one-host deployment recoverable and rollbackable.

### Ask first

- changing from SQLite/local storage to PostgreSQL/Redis/object storage;
- adding Kubernetes or multi-host scheduling;
- changing the Remotion composition's public scene contract;
- adding a new external provider with credentials/cost/data-sharing implications;
- enabling authenticated/private social scraping;
- allowing private/internal media URLs in production;
- exposing the app directly to the public internet;
- introducing user accounts, roles, or multi-tenancy;
- destructive database migrations;
- automatically publishing rendered content to social platforms.

### Never do

- depend on n8n for the standalone production workflow;
- commit secrets/credential JSON files;
- treat prompt text or external page content as a permission boundary;
- follow instructions embedded in fetched pages/social content;
- allow model output to select arbitrary privileged tools/URLs without validation;
- fetch localhost/private/cloud-metadata URLs from user/model input by default;
- expose raw stack traces/provider payloads/secrets to operators;
- render from mutable draft data after approval;
- leave a job permanently stuck after worker restart without a recovery path;
- disable failing tests/security checks merely to ship;
- make destructive schema changes in the same rollout that removes backward compatibility.

---

## Success Criteria

The standalone milestone is accepted when all of the following are demonstrated with evidence:

1. **No n8n dependency:** production Compose starts and functions without any n8n service/network/workflow.
2. **Topic-to-draft:** operator can create a project from a creator/topic and optional public URLs and receive persisted normalized sources, supported/unverified claims, script, voiceover plan, and scene plan.
3. **Public-source safety:** search/URL fetch paths enforce shared SSRF/redirect/timeout/size controls and tolerate inaccessible social/public pages without fabricating content.
4. **Provenance:** every supported factual claim references stored source IDs; invented citations are rejected.
5. **Human gate:** render cannot begin until an explicit approved revision exists; editing approved content invalidates approval.
6. **Deterministic assets:** approved remote media is ingested/validated locally before render; normal rendering no longer depends on arbitrary remote URLs or globally disabled browser web security.
7. **Durable jobs:** queued/in-progress jobs survive app/worker restart and are either resumed/retried or moved to a clear recoverable failure state.
8. **Standalone UI:** operator can create, monitor, review/edit, approve, retry/cancel where safe, render, and download without editing JSON manually.
9. **Rendering:** approved project produces a valid H.264 MP4 with expected duration and Google TTS voiceover when enabled.
10. **Production network boundary:** no worker port is public; app access is behind authenticated TLS/private-network boundary; no n8n network coupling remains.
11. **Operations:** liveness/readiness, structured logs, queue/stage visibility, failure visibility, and disk-pressure signal are available.
12. **Reproducible release:** CI uses frozen install, tests, controlled render smoke, and Docker build; production images use immutable release/commit tags with a documented rollback path.
13. **Restart/redeploy verification:** a controlled restart during queued/processing work demonstrates correct recovery behavior.
14. **Security verification:** secret scan/review, SSRF abuse tests, auth boundary tests, provider-output validation tests, and dependency audit are completed/triaged.
15. **Definition of Done:** project-wide correctness, quality, integration, documentation, security/observability, and ship-readiness checks pass before release is declared complete.

---

## Out of Scope for the First Standalone MVP

- public self-service signup;
- multi-tenant data isolation;
- billing/subscriptions/quotas by customer;
- native mobile apps;
- Kubernetes/multi-region/high-availability cluster;
- multiple concurrent render workers across hosts;
- private/authenticated social scraping;
- bypassing platform anti-bot/access controls;
- automatic social publishing;
- user-facing collaborative editing/comments;
- full CMS/library product beyond the project/job history needed for operations;
- replacing the current visual design system or rebuilding all Remotion scenes solely for aesthetic reasons.

---

## Risks and Required Mitigations

### Social/public-source availability is inconsistent

**Risk:** TikTok/Facebook/Instagram/X pages may be inaccessible or unstable to generic HTTP fetchers.  
**Mitigation:** provider abstraction, graceful per-source failure, search-based discovery, explicit unavailable state, no bypass behavior, and human review.

### Prompt injection / hostile source text

**Risk:** external pages may contain instructions intended to redirect model behavior.  
**Mitigation:** external content treated strictly as data, structured provider contracts, tool permissions outside prompts, source-ID validation, URL policy, and mandatory approval.

### Render resource exhaustion

**Risk:** Chromium/FFmpeg rendering can consume CPU/RAM/disk and affect web responsiveness.  
**Mitigation:** separate worker, render concurrency 1 by default, Compose CPU/memory limits, disk preflight, bounded project duration/scenes/media, queueing, and observable stage duration/failure.

### Job loss on restart

**Risk:** current in-memory queue cannot recover reliably after process restart.  
**Mitigation:** durable transactional state, atomic claims/leases, immutable approved revisions, bounded idempotent retry.

### Remote media instability/security

**Risk:** render-time URLs can disappear, redirect, target private networks, or require relaxed Chromium security.  
**Mitigation:** validated pre-download into local artifact store before render; render from trusted local/application assets.

### Provider cost/runaway loops

**Risk:** research/generation retries can spend unbounded time or money.  
**Mitigation:** request/token/time limits, bounded retries, stage attempt counters, explicit retry action after terminal exhaustion, metrics where provider exposes usage.

---

## Open Decisions for `/plan`

These are implementation choices, not missing product intent:

1. Which initial public search/research provider best satisfies required web/social coverage without private scraping or bypass behavior?
2. Which initial LLM/generation provider best supports schema-constrained structured output, Vietnamese content quality, cost limits, and operational reliability?
3. Which authenticated TLS gateway/operator-auth mechanism fits the VPS environment (existing reverse proxy/private network vs Compose-managed gateway)?
4. Which SQLite access/migration implementation best fits Node 24 and repository dependency policy?
5. What default artifact/output retention duration and disk thresholds should the production host use?
6. What minimal web build tooling should be used for the operator UI while reusing React and avoiding unnecessary framework complexity?

These decisions must be made and documented before their corresponding implementation task begins. Provider/framework APIs that are version-sensitive must be verified against current official documentation during `/plan`/`/build`.

---

## Spec Review Gate

Do not proceed to implementation from this document until the human reviewer explicitly approves this spec or requests edits.

After approval, `/plan` must produce:

- dependency graph;
- vertically sliced implementation plan;
- risk-first ordering;
- tasks with acceptance criteria and verification;
- intended `tasks/plan.md` and `tasks/todo.md`;
- explicit provider/auth/storage decisions for the open items above.
