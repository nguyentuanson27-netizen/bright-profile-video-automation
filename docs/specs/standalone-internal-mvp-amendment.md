# Spec: Standalone Bright Profile Internal MVP

**Status:** Active — promotion release-candidate contract  
**Date:** 2026-08-15  
**Branch:** `spec/standalone-production-app`  
**Promotion PR:** #13 → `main`  
**Historical note:** this file began as a scope amendment. It is now the consolidated current spec and supersedes conflicting current-state language in `docs/specs/standalone-production-app.md`, which remains historical design context.

## Assumptions

1. The milestone serves one operator or a small internal team; public SaaS and multi-tenancy are out of scope.
2. The standalone app remains private/loopback or behind a separately approved trusted access boundary. Public exposure is not part of this milestone.
3. The required workflow starts from creator/topic plus optional public URLs and ends with an authoritative downloadable MP4.
4. Human review and explicit approval remain mandatory before media ingest, TTS, and render work.
5. SQLite metadata/state and the local application-owned artifact volume are acceptable for the current single-host internal MVP.
6. OpenAI research/generation, Google Cloud TTS, Remotion, and public-source fetching remain external/untrusted boundaries; application validation and durable fencing remain authoritative.
7. The current functional scope is frozen by `tasks/traceability.md`; historical requirements not retained there are deferred unless explicitly reintroduced.
8. Promotion to `main` is repository integration only. It does not deploy the application or broaden the runtime trust boundary.

## Objective

Provide a standalone internal web application that lets an operator:

1. create a project from creator/topic plus optional public URLs;
2. research public sources and persist normalized evidence/provenance;
3. generate a structured, schema-valid draft through a durable worker stage;
4. review and edit claims, script, voiceover chunks, scene plan, and bounded render settings;
5. explicitly approve an immutable revision;
6. start downstream work through the application render-start control;
7. ingest approved media through the SSRF-safe fetch boundary;
8. run durable Google TTS and Remotion render stages;
9. retry a retryable failed stage or cancel active durable work safely;
10. download the one authoritative validated MP4;
11. survive supported app/worker restarts without duplicate drafts, stages, or authoritative artifacts.

The normal operator path must not require n8n, manually constructed project JSON, direct worker/service invocation, or arbitrary filesystem/media references.

### Target user

An internal content operator or small internal team producing creator-profile videos.

### Frozen operator flow

```text
create
  -> research
  -> generate
  -> review/edit
  -> approve
  -> render-start
  -> media ingest
  -> TTS
  -> render
  -> download
```

## Tech Stack

The repository currently pins:

- Node.js ESM; CI runtime Node `24.18.0`;
- React `19.1.0` + React DOM `19.1.0`;
- Vite `8.1.5`;
- Remotion `4.0.484` (`remotion`, bundler, renderer, transitions);
- Google Cloud Text-to-Speech `6.4.1`;
- OpenAI JavaScript SDK `6.49.0`;
- `better-sqlite3` `13.0.1`;
- Ajv `8.20.0` and Zod `4.4.3`;
- Chromium and FFmpeg/ffprobe in the container runtime;
- Docker / Docker Compose;
- SQLite plus an application-owned persistent artifact volume.

### Runtime topology

- **app:** same-origin React UI + HTTP API; host port is loopback-only by default.
- **worker:** claims durable stages and executes research, generation, media ingest, TTS, and rendering; publishes no HTTP port.
- **shared state:** app and worker share `/app/data`, including `bright-profile.sqlite` and application-owned artifacts.
- **Bright Evidence MCP:** remains a separate read-only ChatGPT integration and is not a runtime dependency of the standalone workflow.

## Commands

Use repository commands exactly as defined by `package.json` and CI:

```sh
# frozen install
npm ci --ignore-scripts --no-audit --no-fund
npm rebuild better-sqlite3 --no-audit --no-fund

# quality gates
npm test
npm run lint
npm run audit:standalone
npm run build:web
npm run render:smoke

# database
npm run db:migrate -- --database <path-to-sqlite>

# local runtime
node server.mjs
node worker.mjs
npm run dev:web

# container boundary
docker compose -f compose.yml config
docker compose up -d --build
```

There is no `npm run build` script in the current package contract; the frontend production build command is `npm run build:web`.

## Project Structure

```text
app/                 HTTP handlers, server composition, workflow services
domain/              lifecycle, stable errors, JSON-schema/domain contracts
storage/             SQLite repositories, migrations, durable jobs/artifacts
security/            URL policy, SSRF-safe fetch, standalone audit policy
providers/           research and generation provider contracts/adapters
worker/              durable worker runner
web/                 React/Vite operator UI
lib/evidence/        canonical in-process evidence normalizer
lib/                 Remotion/TTS execution helpers
mcp/                 separate read-only Bright Evidence MCP service
scripts/             migration, render, audit and smoke utilities
tests/unit/          focused domain/provider/security/UI behavior tests
tests/integration/   HTTP, persistence, fencing, E2E, Compose/MCP regressions
docs/                current status, specs, security/operation records
tasks/               implementation plan, checklist, frozen traceability ledger
```

## Code Style

Follow the existing JavaScript ESM style: explicit named exports, small pure domain functions where practical, stable error codes at boundaries, early validation, and simple control flow rather than speculative abstractions.

Representative existing pattern:

```js
export const transitionProject = (project, target) => {
  assertProjectState(project);
  if (nextState.get(project.status) !== target) {
    throw invalidTransition(project.status, target);
  }
  return {...project, status: target, failure: null};
};
```

Conventions:

- ESM imports/exports; `.mjs` for Node modules and `.jsx` for React components.
- Application-owned stable IDs/paths; external/model data cannot choose internal IDs or filesystem destinations.
- Domain/state changes are explicit and transactionally persisted where concurrency matters.
- Reuse canonical helpers (`lib/evidence`, URL/fetch policy, storage fencing) rather than duplicating business logic.
- Do not mix unrelated refactors into release/bug changes.

## Functional Contract

### Projects and research

- Create/list/read projects through the HTTP application boundary.
- Optional operator URLs are validated and fetched only through the canonical SSRF-safe boundary.
- Research persists normalized evidence, source provenance, unavailable-source state, and stable application-owned source IDs.
- Prompt-like source content is untrusted data and never becomes application instruction.

### Generation and review

- Generation runs as a durable worker stage; the HTTP request only enqueues/controls work.
- Model output is locally schema/reference/timeline validated.
- Model claims of human verification/override are ignored.
- Review is structured; raw JSON editing is not the normal operator path.
- Approval creates an immutable approved revision tied to the exact validated payload.

### Approval/downstream race

- Before any descendant media/TTS/render logical stage exists, an approval-relevant edit may invalidate approval and return the project to `review_required`.
- Once descendant work exists, the edit is rejected with the stable downstream-work-started rule.
- Edit and first descendant-stage creation are serialized; mixed invalidated-approval + authorized-descendant state is forbidden.

### Media, TTS, render, output

- Successful render-start creates exactly one first `media_ingest` logical stage for the current approved revision.
- Media ingest uses safe public fetches and application-owned attempt paths; factual citations are not automatically render media.
- TTS/render consume the immutable approved revision and verified local media only.
- Normal Remotion execution keeps Chromium web security enabled and rejects arbitrary remote/file/traversal media references.
- Completion occurs only after the current owner promotes a validated authoritative MP4.
- `GET /api/projects/:id/artifacts/output` serves only that authoritative completed output after path/size/hash revalidation.

### Durable controls

- Long-running stages use lease renewal, claim-token fencing, restart/reclaim handling, and bounded attempts.
- A stale/reclaimed/cancelled owner cannot publish progress, drafts, state, or authoritative artifacts.
- `/retry` is legal only for an explicitly retryable failed logical stage and must not duplicate active/replacement attempts or rerun completed upstream work.
- `/cancel` invalidates active ownership; repeated cancel of the already-cancelled run is a no-op returning the same cancelled state.

## Testing Strategy

The project uses Node's built-in test runner plus CI runtime/container verification.

### Unit tests

Cover domain transitions, schemas, provider parsing/classification, URL/security policies, audit policy, and UI state/control logic.

### Integration tests

Cover SQLite reopen/migrations, HTTP contracts, research/generation/approval flow, retry/cancel, stale-owner fencing, approval races, media ingest, render/output, static UI boundary, and MCP regressions.

### Deterministic E2E

`tests/integration/standalone-e2e.test.mjs` proves the retained standalone workflow without live/paid provider calls, including retry/cancel/reclaim/heartbeat and approval-race invariants.

### Required CI gates

The `Bright Profile Verification` workflow includes:

- frozen dependency install;
- standalone and MCP production dependency audits;
- SQLite native binding + migration smoke;
- full unit/integration suite;
- aggregate lint;
- Vite production build;
- syntax checks;
- standalone API/UI liveness/readiness;
- MCP process health;
- Remotion smoke render;
- standalone Compose config + real app/worker image/runtime boundary;
- retained MCP Compose/container checks;
- teardown.

The same workflow is configured for PRs targeting `main` and pushes to `main`.

## Boundaries

### Always do

- Validate external/operator/model data at application boundaries.
- Keep public URL/media fetching behind the SSRF-safe check-to-connect policy.
- Preserve human approval before downstream artifact-producing work.
- Keep durable write fencing and immutable approved-revision identity intact.
- Keep secrets out of Git, project records, responses, and logs.
- Run the full required verification workflow before promotion/merge.
- Keep the app loopback/private unless a separate trusted access/auth/TLS task is approved.

### Ask first

- Any database schema change or destructive data migration.
- New dependency or version upgrade.
- Breaking API/schema/state-machine change.
- Authentication/authorization or public network exposure change.
- CI gate removal/weakening.
- Scope expansion beyond the frozen internal MVP.

### Never do

- Commit provider credentials or local credential files.
- Trust model/RAG/source content as authorization, human approval, or privileged instruction.
- Bypass SSRF controls for operator/model-influenced URLs.
- Use caller-controlled filenames/paths for authoritative artifacts.
- Disable Chromium web security as the normal render solution.
- Silence, skip, or weaken failing required tests/audits to make CI green.
- Reintroduce n8n/manual project JSON as a required normal operator path.

## Success Criteria

Implementation/runtime criteria already evidenced by T01–T16 and closure CI:

- [x] The frozen create → download workflow is implemented through supported application controls.
- [x] Research evidence/source provenance is persisted and model/application references are locally validated.
- [x] Generation, media ingest, TTS, and render use durable worker stages with restart/reclaim/fencing guarantees.
- [x] Human approval creates an immutable approved revision and the approval/downstream edit race has only the two allowed serialized outcomes.
- [x] Retry/cancel semantics are durable, bounded, idempotent where specified, and regression-covered.
- [x] Public URL/media fetches are covered by SSRF, DNS-rebinding, redirect, credential, MIME, size, and timeout protections.
- [x] Rendering consumes application-controlled local approved media and publishes one validated authoritative MP4.
- [x] React/Vite UI supports create/status/research/review/edit/approve/render/retry/cancel/download without raw JSON.
- [x] `compose.yml` contains the standalone app/worker topology for the normal workflow and does not depend on n8n.
- [x] Standalone root production dependency audit and retained MCP verification are green on the release-closure source state.

Release/promotion criteria still governed by `/ship`:

- [x] PR #12 release-closure exact-head CI passed.
- [x] PR #12 merged into `spec/standalone-production-app`.
- [x] Post-merge source-branch push CI `31825258653` passed on merge commit `5594bc16d9ce30c5155a0f5ec4bb261bdaf431cf`.
- [x] Promotion PR #13 `spec/standalone-production-app -> main` is open.
- [ ] Fresh full promotion CI is green on the **final exact promotion head**, including documentation-sync commits.
- [ ] Real-browser keyboard/focus/console smoke evidence required by the ship audit is recorded as passing, or the human release owner explicitly resolves that gate.
- [ ] A human explicitly approves the final promotion head.
- [ ] PR #13 is merged to `main`.
- [ ] Post-merge `main` push verification completes successfully.

## Current Implementation and Release Status

T01–T16 are implemented on `spec/standalone-production-app`.

PR #11 completed the React/Vite UI, two-service app/worker Compose closure, deterministic standalone E2E, and final CI/container gates. PR #12 then synchronized the current spec/status, added the ship audit/rollback plan, and extended verification to promotion PRs/pushes.

PR #12 merged as `5594bc16d9ce30c5155a0f5ec4bb261bdaf431cf`; its post-merge source-branch workflow `31825258653` completed **SUCCESS**.

Promotion PR #13 is now the active repository-integration gate. `main` has not yet received this MVP.

## Deferred / Out of Scope

- Public SaaS, multi-tenancy, billing, public signup, or customer isolation.
- Public Plugins Directory/commercial launch work.
- Codex/desktop marketplace completion.
- Add/remove source URLs after creation and rerun research.
- Regenerate an already reviewable draft from the same source set.
- Rerender an already completed revision as a new run.
- Raw approved-manifest export as a separate operator artifact.
- Full production SLO/metrics platform, multi-host failover, Kubernetes, or multi-region architecture.
- Public TLS/OAuth/browser-account system while the app remains private/loopback/trusted-network only.

## Open Questions

No unresolved product-contract question blocks the frozen internal MVP.

Remaining release-only decisions are:

1. whether the final promotion-head browser keyboard/focus/console ship gate is satisfied by recorded evidence or explicitly resolved by the human release owner;
2. when the human release owner approves and merges PR #13 after fresh exact-head CI;
3. if the merged code will be deployed to a persistent internal host, which operator owns the pre-deploy data snapshot and rollback execution.

## Traceability

`tasks/traceability.md` remains the binding requirement → task → implementation → regression → final-gate ledger. If a future change adds a retained requirement, update that ledger before implementation.
