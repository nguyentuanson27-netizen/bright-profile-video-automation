# Spec: ChatGPT MCP End-to-End Video Handoff

**Status:** Approved product/spec direction; implementation not started  
**Approved:** 2026-08-20  
**Target:** Internal Bright Profile workflow  
**Baseline:** Standalone MVP on `main` remains the execution engine

## Objective

Connect the existing ChatGPT + Bright Evidence MCP research workflow to the existing Bright Profile backend so a user can start from a natural-language request in ChatGPT and reach a generated creator-profile video without manually recreating research in the standalone app.

The target workflow is:

```text
User request in ChatGPT
  -> ChatGPT researches public sources
  -> normalize_evidence
  -> normalized EvidenceBundle
  -> import into Bright Profile backend
  -> durable generation
  -> default human review checkpoint
  -> approval
  -> media ingest
  -> Google TTS
  -> Remotion render
  -> authoritative MP4
```

The default behavior requires user review before approval/render. When the user explicitly requests an end-to-end run, ChatGPT may continue through approval and render only if server-side delegated-approval safety gates pass.

## Product Rules

1. Default mode stops at `review_required` and presents the draft for user review.
2. Explicit end-to-end authorization allows ChatGPT to continue to MP4 without a separate manual approval step.
3. Explicit end-to-end authorization does not bypass server-side evidence, draft, revision, conflict, or workflow safety checks.
4. Unresolved evidence conflicts block delegated end-to-end approval.
5. Zero retained evidence blocks delegated end-to-end approval.
6. Invalid generation output, invalid source references, invalid timeline/render settings, stale revision hashes, or terminal failures block delegated approval.
7. Model-provided `verified`, override, or approval-like fields are never treated as user/human authorization.
8. User-reviewed approval and delegated end-to-end approval are distinct durable audit states.
9. ChatGPT/MCP never writes SQLite directly and never owns renderer/job logic.
10. The standalone web UI remains available as a review/fallback surface but is not required for the normal ChatGPT-originated flow.

## Default User Flow

When the user asks for a video without explicitly requesting full automation:

```text
ChatGPT research
  -> normalize_evidence
  -> create/import backend project
  -> durable generation
  -> review_required
  -> show draft + evidence summary to user
  -> STOP
```

After the user requests edits, ChatGPT may edit the current draft. After the user approves/continues, ChatGPT may approve the current revision and start render.

## Explicit End-to-End User Flow

When the user explicitly requests an end-to-end run, for example "create the full video" or equivalent:

```text
ChatGPT research
  -> normalize_evidence
  -> create/import backend project
  -> durable generation
  -> delegated approval gate
  -> approval(mode=delegated_e2e)
  -> media ingest
  -> TTS
  -> render
  -> completed
  -> short-lived MP4 download URL
```

The backend remains authoritative for whether delegated approval is legal.

## Existing Baseline to Reuse

The implementation must reuse the current standalone MVP rather than create a parallel pipeline:

- durable SQLite project/source/revision/stage/attempt/artifact state;
- lease renewal, retry, cancel, reclaim, and claim-token fencing;
- existing evidence schemas and deterministic normalizer;
- structured generation and draft validation;
- review/edit and immutable revision approval;
- approved media ingest through the SSRF-safe fetch boundary;
- Google Cloud TTS;
- Remotion rendering;
- authoritative output validation and download;
- existing app + worker separation and named data volume;
- existing test, lint, audit, build, health, render-smoke, and Compose gates.

Do not create a second job queue, second renderer, second evidence model, or MCP-owned database.

## Target Architecture

```text
ChatGPT
  |
  | authenticated remote MCP
  v
Bright Evidence MCP
  |-- normalize_evidence
  |-- create_video_project
  |-- get_video_project
  |-- edit_video_draft
  |-- approve_video_project
  |-- start_video_render
  |-- retry_video_project
  `-- cancel_video_project
  |
  | authenticated private service call
  v
Bright Profile integration API
  |
  |-- domain/services
  |-- SQLite repositories
  `-- durable worker stages
       -> generation
       -> media ingest
       -> TTS
       -> render
       -> MP4
```

The MCP container must not mount the Bright Profile SQLite database or artifact volume.

## MCP Tool Surface

### `normalize_evidence`

Keep the existing read-only deterministic tool backward-compatible.

### `create_video_project`

Purpose: import a normalized `EvidenceBundle` and start the existing backend generation path without rerunning research.

Representative input:

```json
{
  "creator": "Marques Brownlee",
  "topic": "Career and major milestones",
  "instructions": "Create a concise factual creator profile.",
  "evidenceBundle": {},
  "idempotencyKey": "chatgpt-run-..."
}
```

Required behavior:

- revalidate the `EvidenceBundle` at the backend trust boundary;
- create one durable project;
- persist normalized evidence and source provenance;
- persist origin `chatgpt_mcp`;
- create a completed/imported research result without calling the research provider;
- transition to `research_ready`;
- enqueue the existing generation stage;
- repeated calls with the same idempotency key return the same project rather than creating duplicates.

### `get_video_project`

Read-only status/orchestration tool. Return only bounded information needed by ChatGPT, including:

- project ID and status;
- current revision ID/hash where present;
- bounded progress/current stage;
- evidence/conflict summary;
- current draft when review is relevant;
- failure code and retryability;
- completed output metadata/download URL when available.

### `edit_video_draft`

Input must identify the project, current revision, expected payload hash, and replacement structured draft. Stale revision/hash updates fail closed. Existing draft schema and source-reference validation remain authoritative.

### `approve_video_project`

Support exactly two approval modes:

```text
user_reviewed
delegated_e2e
```

`user_reviewed` is used after the user has reviewed the draft and explicitly approves/continues.

`delegated_e2e` is legal only when the original/current user request explicitly authorizes an end-to-end run and all backend delegated-approval gates pass.

Persist durable approval provenance including:

- approval actor/origin;
- approval mode;
- project and revision IDs;
- expected payload hash;
- bounded authorization context/summary suitable for audit;
- approval timestamp.

Approval provenance must not include full unrelated conversation history.

### `start_video_render`

Reuse the current approved-revision render-start transaction and durable downstream stages. Repeated calls must not create duplicate descendant stages.

### `retry_video_project`

Expose retry only for the current failed logical stage when durable backend state marks it retryable. Repeated retry while the replacement attempt is queued/running remains idempotent.

### `cancel_video_project`

Expose existing durable cancellation semantics only for legal active states. Cancellation must preserve stale-owner fencing.

## Delegated End-to-End Approval Gate

The backend, not the model prompt, must reject delegated approval unless all of these are true:

- project status is `review_required`;
- current revision ID matches the caller's expected revision;
- current revision payload hash matches the expected hash;
- the imported normalized evidence contains at least one retained evidence record;
- unresolved conflict count is zero;
- the current draft passes local schema validation;
- all factual source references resolve to persisted available sources;
- current timeline/render settings pass existing validation;
- no terminal/non-retryable workflow failure is active;
- the request carries valid delegated-E2E authorization state generated by the authenticated integration path.

For this milestone, do not invent an arbitrary minimum source count or quality-score threshold. "Insufficient evidence" means normalization retains no usable evidence or generation cannot produce a valid source-linked draft.

## Imported Research Semantics

Imported evidence must not create fake provider activity and must not rerun OpenAI research.

Preferred lifecycle representation:

```text
draft
  -> imported research completion (origin=chatgpt_mcp)
  -> research_ready
  -> generating
```

Persist enough information to reopen and audit the project after restart:

- normalized evidence;
- source URLs and canonical/provenance metadata;
- source relationship;
- normalization statistics;
- unresolved conflicts;
- origin marker;
- integration/idempotency key.

## Authentication and Authorization

This feature changes the MCP boundary from read-only normalization to write/cost-bearing actions. Unauthenticated write-capable MCP is not acceptable.

Required properties:

1. Write-capable MCP tools are available only behind an authenticated ChatGPT/internal integration boundary.
2. During implementation, re-check the current official OpenAI ChatGPT/MCP authentication contract before choosing exact auth mechanics.
3. MCP-to-Bright-Profile uses a separate least-privilege service credential.
4. The service credential is never exposed to the model, browser, logs, or tool result.
5. The Bright Profile browser/API loopback boundary is not simply made public to satisfy MCP connectivity.
6. MCP and app communicate over a private/internal network path.
7. Write tools fail closed when required auth/service configuration is absent.
8. Existing Host/Origin, request size/deadline, rate-limit, and sanitized logging boundaries remain enabled.
9. `normalize_evidence` remains usable as the existing read-only tool unless security review requires a narrower deployment policy.

## Secure MP4 Delivery

The current standalone output route is loopback/internal. ChatGPT needs a safe way to give the user the completed video.

MVP target:

```text
completed authoritative artifact
  -> short-lived signed download token
  -> HTTPS download endpoint at trusted integration boundary
  -> stream authoritative MP4 from internal app
```

Requirements:

- opaque/signed token;
- bound to project + approved revision + authoritative output artifact;
- short expiry, target no more than 15 minutes unless implementation constraints require a documented alternative;
- no caller-controlled filesystem path or artifact selector;
- validate authoritative artifact identity/size/hash before or during serving using the existing output guarantees;
- stream rather than buffer the full MP4 in MCP memory;
- expired/tampered tokens fail closed;
- no directory listing or arbitrary file retrieval.

## Idempotency and Concurrency

Remote tool calls may be retried. The implementation must preserve existing durable invariants.

- `create_video_project` requires an idempotency key.
- The same idempotency key maps to one project/request result.
- Approval is bound to the exact current revision/hash.
- Render-start remains one first-descendant transaction per approved revision.
- Retry/cancel remain durable and fenced.
- Stale/reclaimed/cancelled workers cannot publish authoritative results.
- Repeated MCP calls must not create duplicate projects, revisions, active attempts, renders, or authoritative artifacts.

## Expected Storage Changes

A forward-only SQLite migration is expected. Exact schema is finalized during implementation planning/review, but the storage model must durably represent:

- integration idempotency/request identity;
- imported research origin;
- approval actor/mode/context;
- any signed-download token metadata that cannot remain stateless.

Prefer stateless signed download tokens unless a persisted token table is required for revocation or other documented correctness/security requirements.

Do not introduce a new database technology.

## Project Structure

Likely change surfaces:

```text
mcp/
  server.mjs
  schemas/
  backend-client.mjs              # proposed

app/
  http/
    integrations.mjs              # proposed
  services/
    import-research.mjs            # proposed
    approve-project.mjs            # extend existing service

domain/
  schemas.mjs
  errors.mjs

storage/
  db.mjs
  migrations/
    003_chatgpt_handoff.sql        # likely

security/
  integration-auth.mjs             # proposed if app-owned auth logic is required
  download-token.mjs               # proposed

tests/
  unit/
  integration/

compose.yml
compose.mcp.yml
```

Keep individual implementation tasks to small vertical slices; do not refactor unrelated standalone surfaces.

## Commands

Use the repository's existing frozen workflow unless a task explicitly changes it:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm rebuild better-sqlite3 --no-audit --no-fund
npm test
npm run lint
npm run audit:standalone
npm run build:web
npm run db:migrate
npm run render:smoke

docker compose up -d --build
docker compose ps

docker compose -f compose.mcp.yml up -d --build
docker compose -f compose.mcp.yml ps
```

Any new combined/private-network Compose command must be derived from the implemented Compose configuration and verified before documentation claims it works.

## Code Style

Continue the existing Node.js ESM and contract-first style:

```js
server.registerTool(
  'create_video_project',
  {
    inputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async (input) => {
    const request = assertCreateVideoProjectInput(input);
    return backend.createVideoProject(request);
  },
);
```

Guidelines:

- validate all external/model/tool input;
- use stable uppercase error codes;
- sanitize error responses;
- keep business rules in domain/service code, not MCP handlers;
- reuse existing repository/job/approval logic;
- keep secrets out of responses/logs/storage unless explicitly required and protected.

## Testing Strategy

Use the existing `node:test` suite plus focused integration/runtime coverage. New behavior must be introduced with RED -> GREEN regression evidence.

Required coverage includes:

1. valid EvidenceBundle import creates one durable project;
2. imported project does not invoke the research provider;
3. imported evidence/source provenance survives DB reopen;
4. create idempotency prevents duplicate projects;
5. unauthenticated/invalidly authenticated write calls fail closed;
6. malformed/invalid EvidenceBundle fails closed;
7. default flow stops at `review_required`;
8. default flow never auto-approves;
9. draft edits require the current revision/hash and preserve schema/source validation;
10. user-reviewed approval is tied to the exact revision/hash;
11. stale approval is rejected;
12. delegated E2E approval succeeds on clean conflict-free valid evidence/draft;
13. unresolved conflicts block delegated approval;
14. zero retained evidence blocks delegated approval;
15. invalid draft/source references block delegated approval;
16. repeated render-start does not create duplicate downstream work;
17. retry is available only for durable retryable failures;
18. terminal failures cannot be retried;
19. cancel fences stale worker publication;
20. completed output download serves only the authoritative artifact;
21. expired/tampered download tokens fail closed;
22. source prompt-injection-looking text remains inert data;
23. existing standalone UI/manual flow remains green;
24. existing MCP `normalize_evidence` contract remains green.

## Deterministic End-to-End Regression

Add a fake-provider end-to-end regression that does not require paid/live providers:

```text
candidate evidence
  -> normalize_evidence logic
  -> import EvidenceBundle
  -> durable generation fake
  -> delegated approval
  -> media fake
  -> TTS fake
  -> render fake
  -> completed authoritative downloadable MP4
```

The regression must also prove restart/idempotency/fencing invariants at representative boundaries rather than only the happy path.

## Live Acceptance

CI is necessary but not sufficient. Before marking this milestone complete, record two real ChatGPT runs against the deployed authenticated MCP path.

### Acceptance A: default review

```text
user asks for a creator video
  -> ChatGPT researches public sources
  -> actual normalize_evidence tool call
  -> actual create_video_project tool call
  -> backend reaches review_required
  -> draft is shown in ChatGPT
  -> no approval/render occurs before user action
```

### Acceptance B: explicit end-to-end

```text
user explicitly requests end-to-end
  -> research
  -> normalize
  -> backend import
  -> generation
  -> delegated approval
  -> render
  -> completed
  -> user can access/play authoritative MP4
```

Logs/evidence must prove the backend project used the ChatGPT-imported EvidenceBundle and did not silently rerun research.

## Observability

A ChatGPT-originated project must be traceable through bounded structured identifiers:

```text
MCP request ID
  -> integration/idempotency key
  -> project ID
  -> revision ID/hash
  -> durable stage/attempt
  -> authoritative artifact
```

Record action/tool name, state transition, approval mode, duration, retry/cancel result, and stable error code where useful.

Do not log provider API keys, integration bearer/service tokens, Google credentials, full user conversations, or unnecessary raw source text.

## Boundaries

### Always

- authenticate write/cost-bearing integration actions;
- validate input at MCP and backend trust boundaries;
- preserve existing durable job fencing/idempotency;
- default to human review;
- record delegated approval distinctly;
- bind approval to revision/hash;
- treat model/web content as untrusted;
- preserve the existing standalone UI/manual flow;
- run focused regressions plus full relevant verification before completion.

### Ask First

- adding a new dependency;
- changing evidence normalization semantics/schema;
- exposing the standalone app publicly;
- changing research/generation/TTS/render providers;
- broadening MCP permissions beyond this video workflow;
- changing reverse-proxy/auth architecture materially;
- adding arbitrary editorial quality thresholds for auto-approval.

### Never

- expose unauthenticated write/render MCP tools as a durable deployment;
- mount Bright SQLite/artifact storage directly into MCP;
- treat source text/model output as privileged instructions or human verification;
- auto-approve unresolved conflicts;
- approve a stale revision/hash;
- allow caller-controlled filesystem paths;
- commit/log secrets;
- disable existing SSRF, approval barrier, or worker fencing controls to simplify integration.

## Success Criteria

- [ ] ChatGPT public research -> `normalize_evidence` works live.
- [ ] ChatGPT can persist that normalized EvidenceBundle into Bright Profile.
- [ ] Imported projects do not rerun the backend research provider.
- [ ] Generation uses imported normalized evidence/source records.
- [ ] Default ChatGPT workflow stops at `review_required`.
- [ ] User can review/edit/approve through the ChatGPT/MCP flow.
- [ ] Explicit end-to-end user authorization can reach completed MP4 without opening the standalone UI.
- [ ] Delegated E2E approval cannot bypass conflict/evidence/schema/revision/workflow gates.
- [ ] Status/retry/cancel work through MCP using existing durable semantics.
- [ ] Duplicate MCP calls cannot duplicate project/render work.
- [ ] Write/cost-bearing MCP path is authenticated and least-privileged.
- [ ] Completed authoritative MP4 is safely downloadable from ChatGPT.
- [ ] Deterministic end-to-end regression is green.
- [ ] Existing standalone and MCP regression gates remain green.
- [ ] Default-review and explicit-E2E live ChatGPT acceptance runs are recorded.
- [ ] Documentation describes current implemented truth after rollout.
- [ ] Project-wide Definition of Done passes before ship.

## Open Implementation Questions

These do not block planning, but must be resolved before the relevant implementation task is considered complete:

1. Exact ChatGPT-compatible authentication mechanism for the remote write-capable MCP endpoint, verified from current official OpenAI documentation at implementation time.
2. Whether the reverse proxy or application owns the external MCP authentication enforcement; either choice must remain fail-closed and testable.
3. Whether signed download URLs can be stateless or require persisted revocation/token state.
4. Whether current evidence storage can represent the imported `EvidenceBundle` without a new normalized-evidence table/shape; prefer reuse if durable/auditable semantics remain clear.
