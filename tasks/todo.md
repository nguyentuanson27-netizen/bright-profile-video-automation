# Task List: Standalone Bright Profile Internal MVP

Source: `tasks/plan.md`, `docs/project-status.md`, and `docs/specs/standalone-internal-mvp-amendment.md`.

Rules:

- follow dependency order;
- use RED -> GREEN -> REFACTOR for changed behavior;
- keep each task to one focused session and roughly 5 files or fewer;
- stop at checkpoints when required verification is red;
- reuse existing Remotion/TTS/evidence-normalizer code instead of rewriting it;
- do not reintroduce production/commercial/plugin/Codex scope;
- verify current official docs before implementing version-sensitive OpenAI/library APIs;
- the project-wide Definition of Done still applies to every completed task.

---

## T01: Establish standalone config, dependencies, and scripts

**Description:** Add the minimum runtime configuration and pinned dependencies required by the standalone architecture while preserving the existing MCP/render commands and tests.

**Acceptance criteria:**
- [ ] Config validates data/database paths, worker lease/retry limits, fetch bounds, and OpenAI model/API settings without logging secrets.
- [ ] `better-sqlite3` and the official `openai` SDK are pinned in the lockfile after current upstream compatibility/API verification; existing dependency versions are not opportunistically upgraded.
- [ ] Existing `npm test`, `npm run lint`, `npm run render:smoke`, and MCP verification behavior remains available.

**Verification:**
- [ ] `node --test tests/unit/config.test.mjs`
- [ ] `npm test`
- [ ] `npm run lint`
- [ ] `npm run render:smoke`

**Dependencies:** None

**Files likely touched:**
- `package.json`
- `package-lock.json`
- `app/config.mjs`
- `tests/unit/config.test.mjs`
- `eslint.config.js`

**Estimated scope:** Medium (5 files)

---

## T02: Define project lifecycle and shared JSON-schema contracts

**Description:** Encode project states, stable application errors, source/evidence contracts, generation output, mutable draft, immutable approved revision, and render bounds independently from HTTP/storage/provider code.

**Acceptance criteria:**
- [ ] Legal transitions cover `draft -> researching -> research_ready -> generating -> review_required -> approved -> media_ingest -> tts -> render_queued -> rendering -> completed`, with explicit failed/cancelled behavior.
- [ ] Shared schemas reject unknown source references, unsupported scene types, invalid timelines, malformed evidence/drafts, and invalid render settings.
- [ ] Approval-relevant edits have an explicit rule that invalidates prior approval.

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

## T03: Add SQLite migrations and durable repositories

**Description:** Introduce SQLite-backed persistence for projects, normalized sources, revisions, jobs, attempts, and artifact metadata while keeping large files on the existing data volume.

**Acceptance criteria:**
- [ ] A fresh temporary database migrates from version 0 using an explicit migration command.
- [ ] Project/source/revision records survive process close/reopen and preserve foreign-key invariants.
- [ ] Repository APIs cannot mutate an approved revision payload/hash after approval.

**Verification:**
- [ ] `node --test tests/integration/storage.test.mjs`
- [ ] `npm run db:migrate -- --database <temp-db>`
- [ ] `npm run lint`

**Dependencies:** T02

**Files likely touched:**
- `storage/db.mjs`
- `storage/migrations/001_initial.sql`
- `scripts/db-migrate.mjs`
- `tests/integration/storage.test.mjs`

**Estimated scope:** Medium (4 files)

---

## T04: Implement durable stage claims, leases, retries, and recovery

**Description:** Replace the standalone workflow's in-memory scheduling model with SQLite-backed runnable stages and prove safe worker recovery before provider/render integration.

**Acceptance criteria:**
- [ ] Only one worker can atomically claim a runnable stage; a live lease cannot be stolen.
- [ ] Expired work becomes recoverable after simulated worker death, with bounded retry/backoff and no duplicate completion records.
- [ ] Graceful shutdown stops new claims while leaving current work recoverable.

**Verification:**
- [ ] `node --test tests/integration/jobs.test.mjs`
- [ ] Focused test with two competing claimant instances against the same temp DB
- [ ] `npm run lint`

**Dependencies:** T03

**Files likely touched:**
- `storage/jobs.mjs`
- `worker/job-runner.mjs`
- `worker.mjs`
- `tests/integration/jobs.test.mjs`

**Estimated scope:** Medium (4 files)

---

## T05: Build the canonical SSRF-safe HTTP(S) fetch boundary

**Description:** Create one application-owned fetch module for operator/model-influenced public URLs and media, with manual redirect and DNS/IP validation.

**Acceptance criteria:**
- [ ] Public HTTP/HTTPS targets can be fetched within purpose-specific timeout/byte/MIME limits.
- [ ] Loopback, private, reserved, link-local, cloud-metadata, localhost, and public-to-private redirect targets are rejected.
- [ ] Application/provider auth headers are never forwarded to arbitrary destinations and media can stream to disk without unbounded buffering.

**Verification:**
- [ ] `node --test tests/unit/url-policy.test.mjs`
- [ ] Tests include direct private IP, DNS-to-private result, redirect-to-private, oversize, and timeout cases
- [ ] `npm run lint`

**Dependencies:** T02

**Files likely touched:**
- `security/url-policy.mjs`
- `security/safe-fetch.mjs`
- `tests/unit/url-policy.test.mjs`

**Estimated scope:** Medium (3 files)

---

### Checkpoint A

Before T06, run T01-T05 together. Do not continue if durable reopen/lease recovery or SSRF redirect/DNS controls are unproven.

---

## T06: Define research provider fakes and reuse the existing evidence normalizer in-process

**Description:** Create a narrow research-provider contract and application research service. The service converts provider/operator-source results into atomic evidence candidates and calls the existing `lib/evidence` normalizer directly; it does not call the remote MCP endpoint.

**Acceptance criteria:**
- [ ] Deterministic fake research provider can simulate success, inaccessible sources, timeout, rate limit, and retryable/non-retryable failure.
- [ ] Research service preserves provenance, keeps duplicate/conflicting candidates until normalization, and returns the existing `EvidenceBundle` contract.
- [ ] Prompt-like source content stays inert data and no ChatGPT/MCP transport is required by the standalone service.

**Verification:**
- [ ] `node --test tests/unit/research-service.test.mjs`
- [ ] Existing evidence/MCP normalization tests remain green via `npm test`
- [ ] `npm run lint`

**Dependencies:** T02, T05

**Files likely touched:**
- `providers/research/index.mjs`
- `tests/fakes/research-provider.mjs`
- `app/services/research-project.mjs`
- `tests/unit/research-service.test.mjs`

**Estimated scope:** Medium (4 files)

---

## T07: Implement the OpenAI Responses web-search adapter

**Description:** Add the first live research adapter using the official OpenAI JavaScript SDK and Responses API `web_search`, mapping provider results into the T06 contract without treating model prose as privileged/final factual storage.

**Acceptance criteria:**
- [ ] Adapter returns public source/citation metadata and evidence candidates through the documented provider contract without inventing application source IDs.
- [ ] Timeout/rate-limit/incomplete/provider failures map to stable application errors and bounded retries; API keys/raw full responses are not logged.
- [ ] Normal CI uses fakes only; a live provider call is manual/gated.

**Verification:**
- [ ] Re-check current official OpenAI Responses/web-search docs and pinned SDK API before implementation commit
- [ ] `node --test tests/unit/openai-research.test.mjs`
- [ ] Optional live smoke with credentials returns at least one source candidate or a classified provider failure

**Dependencies:** T06

**Files likely touched:**
- `providers/research/openai.mjs`
- `tests/unit/openai-research.test.mjs`
- `.env.example`

**Estimated scope:** Medium (3 files)

---

## T08: Deliver create -> research_ready as the first API vertical slice

**Description:** Add the minimal project HTTP surface for create/list/read/research/status, backed by SQLite and durable stages, and persist normalized research evidence.

**Acceptance criteria:**
- [ ] `POST /api/projects` persists creator/topic, optional public URLs/instructions, and returns a stable project ID.
- [ ] Research progresses through durable state to `research_ready`, persisting normalized evidence/source provenance and explicit unavailable-source records.
- [ ] Restarting the app between create/research/read does not lose project or research state; API errors use stable sanitized JSON with request ID.

**Verification:**
- [ ] `node --test tests/integration/research-api.test.mjs`
- [ ] Restart/reopen integration case using a temp DB/data directory
- [ ] `npm run lint`

**Dependencies:** T03, T04, T05, T07

**Files likely touched:**
- `app/http/router.mjs`
- `app/http/projects.mjs`
- `app/server.mjs`
- `server.mjs`
- `tests/integration/research-api.test.mjs`

**Estimated scope:** Medium (5 files)

---

### Checkpoint B

Using deterministic fake research, prove `creator/topic -> research_ready` survives restart and retains source provenance. Then run the optional live OpenAI research smoke if credentials are available.

---

## T09: Implement structured generation from normalized evidence

**Description:** Add the generation provider contract/service and OpenAI Responses Structured Outputs adapter. Generation receives normalized application-owned evidence/source records only and produces a locally validated draft.

**Acceptance criteria:**
- [ ] Output schema contains claims/source references, script, voiceover chunks, and supported Remotion scene plan; local Ajv validation runs after provider output.
- [ ] Unknown source IDs, unsupported scene types, invalid timing/render bounds, malformed/refused/incomplete output are rejected with stable errors.
- [ ] Provider calls have configured timeout/token/retry bounds and do not log full prompts/responses by default.

**Verification:**
- [ ] Re-check current official OpenAI Structured Outputs/Responses docs and pinned SDK API before implementation commit
- [ ] `node --test tests/unit/openai-generation.test.mjs`
- [ ] Optional live smoke with a controlled normalized evidence fixture produces a valid draft or a classified provider failure

**Dependencies:** T06, T08

**Files likely touched:**
- `providers/generation/index.mjs`
- `providers/generation/openai.mjs`
- `app/services/generate-project.mjs`
- `tests/unit/openai-generation.test.mjs`

**Estimated scope:** Medium (4 files)

---

## T10: Add persisted draft editing and immutable approval gate

**Description:** Persist the review-required draft, expose edit/approve actions, block unsafe approval, and create an immutable approved revision snapshot for downstream work.

**Acceptance criteria:**
- [ ] Generate action creates a persisted `review_required` draft; schema-valid edits persist without raw arbitrary JSON/file paths.
- [ ] Approval rejects unknown source references and unverified claims unless each has an explicit stored override reason.
- [ ] Approval creates immutable revision content/hash; approval-relevant edits afterwards return the project to `review_required` and render cannot start from an unapproved draft.

**Verification:**
- [ ] `node --test tests/integration/approval-api.test.mjs`
- [ ] Regression: render request from mutable/unapproved state returns a stable transition error
- [ ] `npm run lint`

**Dependencies:** T03, T09

**Files likely touched:**
- `app/services/approve-project.mjs`
- `app/http/revisions.mjs`
- `storage/revisions.mjs`
- `tests/integration/approval-api.test.mjs`

**Estimated scope:** Medium (4 files)

---

### Checkpoint C

Prove `research_ready -> review_required -> approved` with deterministic generation. Verify bad source references/unverified claims are blocked and post-approval edits invalidate approval.

---

## T11: Ingest approved media into trusted local artifacts

**Description:** Download only approved remote media through T05, validate it, store it under project-owned paths, and persist provenance/hash/type/size for a render-ready local manifest.

**Acceptance criteria:**
- [ ] Remote filenames cannot influence local paths; path traversal, unsupported type, oversize response, and interrupted download are rejected/cleaned safely.
- [ ] Artifact records link the local file to source provenance and the immutable approved revision.
- [ ] Re-running media ingest for the same approved revision is idempotent or atomically replaces an incomplete temporary artifact.

**Verification:**
- [ ] `node --test tests/integration/media-ingest.test.mjs`
- [ ] Focused malicious filename/MIME/oversize/interruption cases
- [ ] `npm run lint`

**Dependencies:** T05, T10

**Files likely touched:**
- `storage/artifacts.mjs`
- `app/services/ingest-media.mjs`
- `tests/integration/media-ingest.test.mjs`

**Estimated scope:** Medium (3 files)

---

## T12: Execute TTS and render as durable worker stages

**Description:** Connect the durable worker to the existing Google TTS and Remotion renderer. Only immutable approved revisions with completed required media ingest can enter TTS/render.

**Acceptance criteria:**
- [ ] Worker records TTS/render stage progress and cannot start them from an unapproved revision or missing required media.
- [ ] Interrupted attempts isolate partial output and can be retried after lease expiry without duplicate completed artifact records.
- [ ] A project reaches `completed` only after output MP4 exists, is non-zero, and passes ffprobe duration/readability validation.

**Verification:**
- [ ] `node --test tests/integration/render-worker.test.mjs`
- [ ] Existing `npm run render:smoke`
- [ ] Simulated worker termination/lease recovery integration case

**Dependencies:** T04, T11

**Files likely touched:**
- `worker.mjs`
- `worker/job-runner.mjs`
- `app/services/execute-render.mjs`
- `tests/integration/render-worker.test.mjs`

**Estimated scope:** Medium (4 files)

---

## T13: Remove arbitrary remote media/default disabled web security from the render path

**Description:** Make the normal standalone render path consume trusted local/application-controlled artifacts only and remove `chromiumOptions.disableWebSecurity: true` from the default Remotion renderer configuration.

**Acceptance criteria:**
- [ ] Normal render manifests contain only local/application-controlled media references produced by T11.
- [ ] Default renderer no longer sets `disableWebSecurity: true`; no broad compatibility escape hatch is silently enabled.
- [ ] Existing supported scene fixtures continue to render successfully.

**Verification:**
- [ ] `node --test tests/integration/renderer-security.test.mjs`
- [ ] `npm run render:smoke`
- [ ] `npm run lint`

**Dependencies:** T11, T12

**Files likely touched:**
- `lib/remotion-renderer.mjs`
- `scripts/render-smoke.mjs`
- `tests/integration/renderer-security.test.mjs`

**Estimated scope:** Medium (3 files)

---

### Checkpoint D

Run a controlled approved fixture through media ingest -> TTS -> render -> output validation. Confirm retry/recovery and no normal dependency on arbitrary remote URLs/default disabled browser security.

---

## T14: Add React/Vite project create and status UI

**Description:** Add the minimal internal SPA shell for project list/create/status using the T08 API, with no raw JSON editing or new browser authentication subsystem.

**Acceptance criteria:**
- [ ] Operator can create a creator/topic project with optional public URLs/instructions and start/observe research.
- [ ] Project list/status shows persisted stage, source/research progress, sanitized failure state, and retry/cancel controls only where legal.
- [ ] Loading/empty/error/pending states and keyboard-usable semantic controls are present; build output is reproducible.

**Verification:**
- [ ] `npm run build`
- [ ] `node --test tests/unit/web-status.test.mjs`
- [ ] Manual/available-browser keyboard walkthrough; if no browser tool exists, record runtime browser verification as pending

**Dependencies:** T08

**Files likely touched:**
- `web/index.html`
- `web/src/main.jsx`
- `web/src/app.jsx`
- `vite.config.mjs`
- `tests/unit/web-status.test.mjs`

**Estimated scope:** Medium (5 files)

---

## T15: Add review, approval, render, and completed UI

**Description:** Complete the internal operator workflow over the T10/T12 API: inspect evidence, edit the draft, approve, render, see progress/errors, and download the final MP4.

**Acceptance criteria:**
- [ ] Review screen shows retained sources/evidence, conflicts/unverified claims, script, voiceover chunks, scene plan, and editable approval-relevant fields.
- [ ] Approve/render actions respect server state; disabled/error UI makes invalid transitions clear rather than bypassing them.
- [ ] Completed state exposes the final MP4 download and approved revision summary without requiring raw project JSON.

**Verification:**
- [ ] `npm run build`
- [ ] `node --test tests/unit/web-review.test.mjs`
- [ ] Manual/available-browser walkthrough of create -> review -> approve -> render -> download against deterministic backend fixtures

**Dependencies:** T10, T12, T14

**Files likely touched:**
- `web/src/app.jsx`
- `web/src/review-view.jsx`
- `web/src/project-view.jsx`
- `tests/unit/web-review.test.mjs`

**Estimated scope:** Medium (4 files)

---

## T16: Remove n8n dependency and prove the standalone MVP end-to-end

**Description:** Replace the current n8n-network Compose topology with app + worker + persistent data, retire the legacy in-memory orchestration path from the normal flow, and add deterministic end-to-end/restart verification.

**Acceptance criteria:**
- [ ] `compose.yml` has no external n8n network dependency; app and worker share the durable DB/artifact volume, worker publishes no port, and app is private/loopback by default.
- [ ] Normal operator flow `creator/topic -> research -> review -> approve -> render -> MP4` works using deterministic fake providers without n8n or manually supplied render JSON.
- [ ] App restart preserves project state and worker lease expiry/recovery resumes supported work; existing MCP and render regression suites remain green.

**Verification:**
- [ ] `node --test tests/integration/standalone-e2e.test.mjs`
- [ ] `docker compose config`
- [ ] `npm test && npm run lint && npm run build && npm run render:smoke`
- [ ] Project-wide Definition of Done review

**Dependencies:** T03, T04, T12, T13, T15

**Files likely touched:**
- `compose.yml`
- `server.mjs`
- `scripts/standalone-smoke.mjs`
- `tests/integration/standalone-e2e.test.mjs`
- `README.md`

**Estimated scope:** Medium (5 files)

---

## Final acceptance checklist

Do not declare the standalone MVP complete until all are observed:

- [ ] An internal operator can start from creator/topic + optional public URLs.
- [ ] Research produces persisted normalized evidence with provenance using the existing in-process normalizer.
- [ ] Structured generation produces a reviewable draft tied to stored sources.
- [ ] Human approval produces an immutable approved revision.
- [ ] Approved media is ingested safely before TTS/render.
- [ ] TTS/render run through durable worker stages and produce a validated MP4.
- [ ] App restart does not lose project state; expired worker lease recovers safely.
- [ ] Normal render path does not depend on arbitrary remote media or default `disableWebSecurity`.
- [ ] UI supports create/status/review/approve/render/download without raw JSON.
- [ ] `compose.yml` no longer depends on n8n.
- [ ] Existing Bright Evidence MCP integration/tests remain green but are not a runtime dependency of the standalone app.
- [ ] No production/commercial/Codex/desktop-marketplace work was added outside scope.
- [ ] Project-wide Definition of Done passes.

## Human approval gate

- [ ] User reviewed and approved this revised `/plan` before `/build` starts.
