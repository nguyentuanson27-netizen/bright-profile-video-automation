# Task List: Standalone Bright Profile Production App

Source: `tasks/plan.md` and `docs/specs/standalone-production-app.md`.

Rules for implementation:
- follow dependency order;
- use RED -> GREEN -> REFACTOR for changed behavior;
- keep each task focused to the listed concern;
- do not start the next checkpoint while required verification is red;
- do not silently substitute providers/auth/storage choices from the approved plan.

---

## T01: Establish test, lint, dependency, and config foundation

**Description:** Add the minimum repository tooling needed for safe incremental implementation: Node test command, ESLint, pinned production dependencies for the chosen architecture, validated configuration module, and consistent scripts. Keep existing render commands working.

**Acceptance criteria:**
- [ ] `npm test` runs Node's built-in test runner and has at least one passing configuration/tooling test.
- [ ] `npm run lint` exists and checks repository JavaScript/JSX without rewriting files automatically.
- [ ] Required dependencies are lockfile-pinned: `better-sqlite3`, `ajv`, official `openai` SDK, and metrics dependency; Vite may be added now or in T14 but must be pinned before UI implementation.
- [ ] `app/config.mjs` fails fast on malformed numeric/boolean/path configuration without logging secret values.

**Verification:**
- [ ] `npm ci`
- [ ] `npm test`
- [ ] `npm run lint`
- [ ] Existing `npm run render:smoke` still runs when its runtime dependencies/credentials are available; if not available in the implementation environment, record it as pending rather than claiming success.

**Dependencies:** None

**Files likely touched:**
- `package.json`
- `package-lock.json`
- `eslint.config.js`
- `app/config.mjs`
- `tests/unit/config.test.mjs`

**Estimated scope:** Medium (5 files)

---

## T02: Define domain workflow, error, and JSON-schema contracts

**Description:** Encode the approved project lifecycle, supported scene/render bounds, source/claim contracts, generation output schema, stable application errors, and transition rules independently of HTTP/storage/provider code.

**Acceptance criteria:**
- [ ] Legal project transitions match the approved spec; invalid transitions return stable domain errors.
- [ ] Shared schemas validate project input, source records, generation output, draft revisions, and approved render snapshots.
- [ ] Supported claims cannot reference unknown `sourceId` values; unverified claims are represented explicitly.

**Verification:**
- [ ] `node --test tests/unit/domain.test.mjs`
- [ ] `npm run lint`

**Dependencies:** T01

**Files likely touched:**
- `domain/project.mjs`
- `domain/schemas.mjs`
- `domain/errors.mjs`
- `tests/unit/domain.test.mjs`

**Estimated scope:** Medium (4 files)

---

## T03: Add SQLite schema, migrations, and repositories

**Description:** Introduce the durable metadata store with explicit migrations and repository functions for projects, sources, revisions, artifacts, and job metadata. Use `better-sqlite3` with WAL/foreign keys/busy timeout and parameterized statements.

**Acceptance criteria:**
- [ ] A fresh database can migrate from version 0 to the current schema using one documented command.
- [ ] Project/source/revision records survive process close/reopen and preserve foreign-key invariants.
- [ ] Approved revision payload/hash cannot be mutated through repository APIs.

**Verification:**
- [ ] `node --test tests/integration/storage.test.mjs`
- [ ] `npm run db:migrate -- --database <temp-db>` or the final repository-equivalent focused migration command
- [ ] `npm run lint`

**Dependencies:** T02

**Files likely touched:**
- `storage/db.mjs`
- `storage/migrations/001_initial.sql`
- `scripts/db-migrate.mjs`
- `tests/integration/storage.test.mjs`

**Estimated scope:** Medium (4 files)

---

## T04: Implement durable job claims, leases, retries, and recovery

**Description:** Replace the in-memory queue contract with SQLite-backed runnable jobs/stages. Prove atomic claim, lease expiry, bounded retry, and graceful recovery before connecting external providers/rendering.

**Acceptance criteria:**
- [ ] Only one worker can claim a runnable job/stage atomically.
- [ ] An expired lease becomes recoverable after a simulated worker crash; a live lease cannot be stolen.
- [ ] Retryable failures use bounded attempt counts/backoff; non-retryable failures do not loop.
- [ ] Re-running an idempotent stage does not duplicate state transitions/artifact records.

**Verification:**
- [ ] `node --test tests/integration/jobs.test.mjs`
- [ ] Run a test with two competing claimant instances against the same temp SQLite DB.
- [ ] `npm run lint`

**Dependencies:** T03

**Files likely touched:**
- `storage/jobs.mjs`
- `domain/workflow.mjs`
- `worker/job-runner.mjs`
- `tests/integration/jobs.test.mjs`

**Estimated scope:** Medium (4 files)

---

## T05: Build the canonical SSRF-safe URL fetcher

**Description:** Extract/replace URL validation into one safe HTTP(S) fetch boundary used by research and media ingest. Use manual redirects and DNS validation; do not rely on browser/renderer security settings.

**Acceptance criteria:**
- [ ] HTTP/HTTPS public URLs can be fetched within configured timeout/byte/MIME limits.
- [ ] Loopback, private, reserved, link-local, cloud-metadata, localhost, and redirect-to-private targets are rejected.
- [ ] Each redirect is revalidated; auth/provider headers are never forwarded to arbitrary destinations.
- [ ] Safe fetch can stream an allowed media response to a caller without buffering unbounded content.

**Verification:**
- [ ] `node --test tests/unit/url-policy.test.mjs`
- [ ] Tests include direct private IP, DNS result to private IP, and public -> private redirect cases.
- [ ] `npm run lint`

**Dependencies:** T02

**Files likely touched:**
- `security/url-policy.mjs`
- `security/safe-fetch.mjs`
- `tests/unit/url-policy.test.mjs`

**Estimated scope:** Medium (3 files)

---

### Checkpoint A

Before T06, verify T01-T05 together. The system must have deterministic tests for durable state/recovery and SSRF controls. Do not continue if either foundation is unproven.

---

## T06: Define provider interfaces and deterministic fakes

**Description:** Create narrow research and generation interfaces plus fakes so application workflows can be built/tested without live API credentials or cost.

**Acceptance criteria:**
- [ ] Research provider returns normalized discovery records/source candidates only through the documented contract.
- [ ] Generation provider accepts normalized source records and returns the shared structured generation contract.
- [ ] Fake providers can deterministically simulate success, timeout, rate limit, malformed output, inaccessible source, and retryable/non-retryable failure.

**Verification:**
- [ ] `node --test tests/unit/provider-contracts.test.mjs`
- [ ] `npm run lint`

**Dependencies:** T02, T05

**Files likely touched:**
- `providers/research/index.mjs`
- `providers/generation/index.mjs`
- `tests/fakes/providers.mjs`
- `tests/unit/provider-contracts.test.mjs`

**Estimated scope:** Medium (4 files)

---

## T07: Implement OpenAI web-search research adapter

**Description:** Implement the first research adapter using the OpenAI Responses API web-search tool. Treat search results as discovery metadata; feed discovered URLs into the application's normalized source pipeline rather than trusting model prose as factual storage.

**Acceptance criteria:**
- [ ] Adapter records web-search source URLs/citation metadata in the provider contract without inventing source IDs.
- [ ] Timeouts/rate limits/incomplete/provider failures map to stable application errors and bounded retry behavior.
- [ ] Model/provider configuration comes from validated env; API keys/raw response bodies are not logged.
- [ ] No live provider call is required for normal CI tests.

**Verification:**
- [ ] `node --test tests/unit/openai-research.test.mjs`
- [ ] Manual/gated live smoke with credentials: one creator query returns at least one normalized search source or a clear provider failure.
- [ ] Re-check official OpenAI Responses/web-search docs and pinned SDK version before implementation commit.

**Dependencies:** T06

**Files likely touched:**
- `providers/research/openai.mjs`
- `tests/unit/openai-research.test.mjs`
- `.env.example`

**Estimated scope:** Medium (3 files)

---

## T08: Implement OpenAI structured generation adapter

**Description:** Implement the generation adapter using Responses API JSON-schema structured output. Generation receives stored normalized sources and cannot browse/fetch arbitrary new URLs during this stage.

**Acceptance criteria:**
- [ ] Requested output schema matches the shared generation schema and the returned object is locally validated again.
- [ ] Unknown source references, unsupported scene types, invalid timeline bounds, and malformed output are rejected before persistence.
- [ ] Provider incomplete/refusal/timeout/rate-limit states are classified without leaking raw prompt/response content.
- [ ] Production model configuration supports an explicit pinned snapshot ID.

**Verification:**
- [ ] `node --test tests/unit/openai-generation.test.mjs`
- [ ] Manual/gated live smoke with a controlled normalized-source fixture returns a valid Vietnamese draft.
- [ ] Re-check official OpenAI structured-output docs and pinned SDK version before implementation commit.

**Dependencies:** T06

**Files likely touched:**
- `providers/generation/openai.mjs`
- `tests/unit/openai-generation.test.mjs`
- `.env.example`

**Estimated scope:** Medium (3 files)

---

## T09: Deliver project creation and research as an API vertical slice

**Description:** Add the minimal HTTP router/error mapping and project API needed to create a topic project, enqueue/execute research, fetch operator URLs through the safe fetcher, normalize sources, and persist `research_ready` state.

**Acceptance criteria:**
- [ ] `POST /api/projects` creates a persisted project with topic/optional URLs and stable ID.
- [ ] Research action progresses through durable job state and stores normalized source records with retrieval status/hash/provenance.
- [ ] Inaccessible URLs remain visible as failed/unavailable sources; the workflow does not fabricate replacement facts.
- [ ] API errors use the spec's stable JSON error shape with request ID.

**Verification:**
- [ ] `node --test tests/integration/research-api.test.mjs`
- [ ] Restart app between create and read; persisted project/sources remain available.
- [ ] `npm run lint`

**Dependencies:** T03, T04, T05, T07

**Files likely touched:**
- `app/http/router.mjs`
- `app/http/projects.mjs`
- `app/services/research-project.mjs`
- `server.mjs`
- `tests/integration/research-api.test.mjs`

**Estimated scope:** Medium (5 files)

---

## T10: Deliver generation, draft editing, and approval gate

**Description:** Add generation from stored sources, editable review draft persistence, approval validation, immutable approved revision snapshot, and invalidation when approved content is edited.

**Acceptance criteria:**
- [ ] Generate action creates a `review_required` draft linked only to stored source IDs.
- [ ] Draft edits are schema-validated and persist without allowing unsupported scene/timeline values.
- [ ] Approval is blocked for unverified claims unless each has an explicit stored override reason.
- [ ] Approval creates an immutable revision snapshot/hash; subsequent relevant edits invalidate approval.

**Verification:**
- [ ] `node --test tests/integration/approval-api.test.mjs`
- [ ] Regression test proves render cannot be requested from mutable/unapproved draft state.
- [ ] `npm run lint`

**Dependencies:** T03, T04, T08, T09

**Files likely touched:**
- `app/services/generate-project.mjs`
- `app/services/approve-project.mjs`
- `app/http/revisions.mjs`
- `tests/integration/approval-api.test.mjs`

**Estimated scope:** Medium (4 files)

---

### Checkpoint B

Before media/render/UI work, prove topic -> research -> generation -> review-required -> approval using deterministic providers. Verify unknown citations and unverified-claim approval failures are blocked.

---

## T11: Ingest approved media into trusted local artifacts

**Description:** Download/validate approved remote media into project-owned local storage, persist provenance/hash/type/size, and produce a render-ready manifest containing only trusted local/application-controlled asset references.

**Acceptance criteria:**
- [ ] Remote filenames cannot influence local paths; path traversal and unsupported media are rejected.
- [ ] Size/MIME/type limits are enforced during streaming download through T05 safe fetch.
- [ ] Artifact records link local media to source provenance and approved revision.
- [ ] Re-running ingest for the same approved revision is deterministic/idempotent or safely replaces an incomplete temp artifact atomically.

**Verification:**
- [ ] `node --test tests/integration/media-ingest.test.mjs`
- [ ] Test malicious filename/path, oversized response, wrong MIME, and interrupted download cleanup.
- [ ] `npm run lint`

**Dependencies:** T05, T10

**Files likely touched:**
- `storage/artifacts.mjs`
- `app/services/ingest-media.mjs`
- `tests/integration/media-ingest.test.mjs`

**Estimated scope:** Medium (3 files)

---

## T12: Execute approved TTS/render stages in the durable worker

**Description:** Connect durable jobs to the existing timed Google TTS and Remotion renderer. The worker consumes only immutable approved revisions and ingested media, records stage progress, and validates final output before completion.

**Acceptance criteria:**
- [ ] TTS/render stages cannot start without an approved revision and completed required media ingest.
- [ ] Interrupted attempts leave isolated partial output and can be safely retried from the approved revision.
- [ ] Final MP4 is marked completed only after file existence/non-zero/ffprobe duration validation.
- [ ] Worker graceful shutdown stops new claims and preserves recoverable state for current work.

**Verification:**
- [ ] `node --test tests/integration/render-worker.test.mjs`
- [ ] Controlled real smoke with local fixture: TTS/render produces readable MP4 when required credentials/runtime exist.
- [ ] Simulated worker termination demonstrates expired-lease recovery without duplicate completed artifact records.

**Dependencies:** T04, T11

**Files likely touched:**
- `worker.mjs`
- `worker/job-runner.mjs`
- `app/services/execute-render.mjs`
- `tests/integration/render-worker.test.mjs`

**Estimated scope:** Medium (4 files)

---

## T13: Harden the Remotion trusted-asset boundary

**Description:** Remove the normal-path dependency on arbitrary remote render URLs and `chromiumOptions.disableWebSecurity: true`. Keep existing scene behavior intact and cover the change with a real render smoke.

**Acceptance criteria:**
- [ ] Normal production render input contains only local/application-controlled trusted asset URLs/data.
- [ ] `disableWebSecurity: true` is removed from the default renderer path; any explicit compatibility escape hatch is off by default and documented/tested.
- [ ] Existing supported scene types still render controlled fixtures.

**Verification:**
- [ ] `npm run smoke:render`
- [ ] `node --test tests/integration/renderer-security.test.mjs`
- [ ] `npm run lint`

**Dependencies:** T11, T12

**Files likely touched:**
- `lib/remotion-renderer.mjs`
- `scripts/render-smoke.mjs`
- `tests/integration/renderer-security.test.mjs`

**Estimated scope:** Medium (3 files)

---

### Checkpoint C

Run the controlled approved-revision fixture through ingest -> TTS -> render -> output validation. Confirm renderer no longer needs arbitrary remote media/global disabled web security.

---

## T14: Add standalone React/Vite project creation and status UI

**Description:** Add the minimal Vite SPA shell and operator screens for project list/create/status, using the existing API and no raw JSON editing.

**Acceptance criteria:**
- [ ] Operator can create a topic project with optional public URLs/instructions.
- [ ] Project list/status screen displays persisted stage, source progress, failure state, retry/cancel controls when allowed.
- [ ] Loading/empty/error/pending states are present and keyboard controls use semantic HTML.
- [ ] `npm run dev` and `npm run build` are documented and build the web assets.

**Verification:**
- [ ] `npm run build`
- [ ] UI-focused tests for create/status behavior using mocked API responses.
- [ ] Keyboard/manual browser walkthrough at representative desktop/mobile width when browser tooling is available; otherwise mark runtime browser verification pending.

**Dependencies:** T01, T09

**Files likely touched:**
- `web/index.html`
- `web/src/main.jsx`
- `web/src/app.jsx`
- `vite.config.mjs`
- `tests/unit/web-status.test.mjs`

**Estimated scope:** Medium (5 files)

---

## T15: Add review/edit/approve/render/completed UI

**Description:** Complete the human checkpoint and output workflow: sources, claims, script, voiceover chunks, scenes, media, overrides, approval, render initiation, and MP4 download.

**Acceptance criteria:**
- [ ] Review UI surfaces each claim's supporting source IDs and clearly marks unverified claims.
- [ ] Operator can edit draft fields, save, override an unverified claim only with reason, approve, and start render.
- [ ] Edits after approval visibly return the project to review-required state.
- [ ] Completed screen downloads the final MP4 and shows approved revision summary; missing/corrupt output is a clear error.

**Verification:**
- [ ] `npm run build`
- [ ] UI-focused tests cover unverified claim block, approval, invalidation, and completed download state.
- [ ] Keyboard/manual browser walkthrough of review/approval path when browser tooling is available.

**Dependencies:** T10, T12, T14

**Files likely touched:**
- `web/src/review.jsx`
- `web/src/project.jsx`
- `web/src/api.mjs`
- `web/src/app.jsx`
- `tests/unit/web-review.test.mjs`

**Estimated scope:** Medium (5 files)

---

### Checkpoint D

Demonstrate the full operator workflow with fake providers and controlled render fixtures without editing JSON manually.

---

## T16: Add structured logs, health/readiness, metrics, and request correlation

**Description:** Make app/worker behavior observable with stable structured events, correlation IDs, health endpoints, and bounded-cardinality metrics.

**Acceptance criteria:**
- [ ] App requests and worker attempts emit structured events with request/project/job/stage fields and no secrets/full source/model payloads.
- [ ] `/health/live` does not depend on providers; `/health/ready` checks DB/data-dir readiness.
- [ ] `/metrics` exposes queue depth, active jobs, failures by stage, provider latency/error counts, and render/stage duration histograms without high-cardinality IDs as labels.

**Verification:**
- [ ] `node --test tests/integration/observability.test.mjs`
- [ ] Induce one controlled failure and locate it by request/project/job correlation fields.
- [ ] Inspect metrics output for expected bounded label sets.

**Dependencies:** T04, T09, T12

**Files likely touched:**
- `app/observability.mjs`
- `app/http/health.mjs`
- `server.mjs`
- `worker.mjs`
- `tests/integration/observability.test.mjs`

**Estimated scope:** Medium (5 files)

---

## T17: Add retention, disk guard, cleanup, and backup operations

**Description:** Implement the approved storage lifecycle defaults and operator commands for cleanup/backup. Guard expensive stages before disk exhaustion.

**Acceptance criteria:**
- [ ] Default retention implements 30-day completed heavy artifacts and 7-day failed/cancelled/unapproved transient artifacts while retaining project/source/approved metadata.
- [ ] New media-ingest/TTS/render work is blocked when disk crosses the configured hard threshold; active jobs are not deleted by cleanup.
- [ ] Backup command creates a consistent SQLite backup plus required approved manifests/source metadata and reports destination/status.
- [ ] Cleanup/backup paths cannot escape the configured data root.

**Verification:**
- [ ] `node --test tests/integration/storage-ops.test.mjs`
- [ ] Dry-run cleanup test lists expected files without deleting active artifacts.
- [ ] Create backup from temp fixture DB/data and restore/read it in a verification test.

**Dependencies:** T03, T11, T12

**Files likely touched:**
- `storage/lifecycle.mjs`
- `scripts/cleanup.mjs`
- `scripts/backup.mjs`
- `tests/integration/storage-ops.test.mjs`

**Estimated scope:** Medium (4 files)

---

## T18: Replace n8n Compose topology with authenticated standalone production stack

**Description:** Build the production Docker/Compose topology with one app image serving app/worker roles, persistent data, Caddy TLS, oauth2-proxy GitHub OAuth allowlist, resource limits, health dependencies, and no n8n network.

**Acceptance criteria:**
- [ ] `compose.yml` contains no external n8n network/service/callback dependency.
- [ ] Only Caddy publishes 80/443; oauth2-proxy/app/worker are private and worker publishes no port.
- [ ] App/worker use the same persistent data root with correct non-root ownership; Google/provider/auth secrets are injected/mounted and not baked into image.
- [ ] Docker build uses lockfile-frozen install semantics and an immutable app image tag convention; package/release/image versions are no longer contradictory.
- [ ] OAuth2 proxy restricts access to explicit GitHub users and forwards only to the private app upstream.

**Verification:**
- [ ] `docker compose config`
- [ ] `docker compose build`
- [ ] `docker compose up -d` in a suitable integration/staging environment
- [ ] `docker compose ps`
- [ ] Verify unauthenticated request does not reach app UI and allowed GitHub login succeeds when real OAuth/TLS config is available.

**Dependencies:** T13, T15, T16, T17

**Files likely touched:**
- `Dockerfile`
- `compose.yml`
- `Caddyfile`
- `.env.example`
- `docs/operations/deployment.md`

**Estimated scope:** Medium (5 files)

---

## T19: Add CI gates, end-to-end smoke, release/rollback runbook, and final DoD evidence

**Description:** Finish the production lifecycle: CI, deterministic E2E smoke, restart recovery rehearsal, deployment/rollback commands, README updates, and Definition-of-Done verification.

**Acceptance criteria:**
- [ ] GitHub Actions gates PR/main on frozen install, lint, unit/integration tests, build, controlled render smoke, Docker build, and dependency audit/triage policy.
- [ ] Deterministic E2E smoke proves create -> research(fake) -> generate -> review/approve -> render -> download.
- [ ] Recovery smoke demonstrates app restart preserves state and expired worker claim is recovered after controlled interruption.
- [ ] Operations docs contain backup/migrate/deploy/health/smoke/rollback commands using immutable image tags and database compatibility notes.
- [ ] README describes the standalone app and no longer instructs users to operate it as an internal n8n service.
- [ ] All spec success criteria and project-wide Definition of Done have explicit verified/pending evidence; no unexecuted check is reported as passed.

**Verification:**
- [ ] `npm ci`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run smoke:render`
- [ ] `npm run smoke:api`
- [ ] `docker compose config`
- [ ] `docker compose build`
- [ ] Review actual GitHub Actions result when available; do not claim CI passed before a run exists.
- [ ] Execute/rehearse documented rollback in staging or mark production-only parts pending with exact commands.

**Dependencies:** T18

**Files likely touched:**
- `.github/workflows/ci.yml`
- `scripts/smoke-e2e.mjs`
- `docs/operations/runbook.md`
- `README.md`
- `package.json`

**Estimated scope:** Medium (5 files)

---

## Final implementation order

```text
T01 -> T02 -> (T03 || T05)
T03 -> T04
T05 + T02 -> T06 -> (T07 || T08)
T03 + T04 + T05 + T07 -> T09
T08 + T09 -> T10
T05 + T10 -> T11 -> T12 -> T13
T09 -> T14
T10 + T12 + T14 -> T15
T04/T09/T12 -> T16
T03/T11/T12 -> T17
T13/T15/T16/T17 -> T18 -> T19
```

`||` means tasks may be safely parallelized if separate working contexts/branches are actually available; do not claim parallel execution otherwise.
