# Task List: ChatGPT MCP End-to-End Video Handoff

Source: `docs/specs/chatgpt-mcp-e2e-video-handoff.md`, `tasks/plan.md`, and `docs/project-status.md`.

T01-T16 belong to the completed standalone MVP baseline and remain covered by `tasks/traceability.md`. This checklist starts at T17 to avoid reusing historical task IDs.

Rules:

- follow dependency order;
- use RED -> GREEN -> REFACTOR for every changed behavior;
- keep each task to one focused session and roughly five files or fewer where practical;
- stop at Checkpoints A/B/C when required verification is red;
- re-check current official OpenAI/ChatGPT MCP authentication behavior before implementing T17 and before live acceptance;
- do not expose write/render MCP tools without authenticated fail-closed behavior;
- MCP must not mount/open the Bright SQLite database or artifact volume;
- reuse existing Bright Profile domain/services/jobs/render/output authority instead of duplicating logic;
- preserve default human review; delegated E2E approval is legal only after explicit user authorization and backend safety checks;
- no task may weaken existing SSRF, approval barrier, retry/cancel, claim fencing, output validation, dependency-audit, or browser Host/Origin controls;
- project-wide Definition of Done applies to every completed task.

---

## T17: Establish authenticated MCP write boundary and private service configuration

**Description:** Resolve and implement the security foundation before any new write/cost-bearing MCP tool can operate. Verify current official OpenAI/ChatGPT MCP authentication guidance and pinned MCP server APIs, define the external authenticated identity boundary plus the MCP->Bright-Profile service credential, and make write capability fail closed when required configuration is absent/invalid.

**Acceptance criteria:**
- [x] Current official OpenAI/ChatGPT MCP auth/tool-confirmation behavior is checked and the chosen auth approach is recorded in the spec/ADR if it materially changes the planned architecture.
- [x] The external write-capable MCP path requires authentication appropriate to the deployed ChatGPT integration; unauthenticated durable write/render access is not enabled.
- [x] MCP->Bright Profile uses a separate least-privilege service credential and a private/internal backend URL; neither is returned to the model/client.
- [x] Missing/invalid auth or service configuration fails closed before side-effecting backend work can start.
- [x] Existing request size/deadline/rate-limit/Host/Origin/log-sanitization controls remain active.
- [x] Secrets/tokens are redacted from errors and logs.

**Verification:**
- [x] Focused unit/integration tests prove missing/invalid external auth is rejected.
- [x] Focused tests prove invalid/missing MCP->backend credential prevents backend mutations.
- [x] Existing `normalize_evidence` tests remain green.
- [x] `npm test`
- [x] `npm run lint`
- [x] Security review against `05_SHARED_REFERENCES.md` auth/authorization/AI-tool checklist.

**Dependencies:** None

**Files likely touched:**
- `mcp/server.mjs`
- `app/config.mjs`
- `security/integration-auth.mjs` or equivalent
- `.env.example`
- focused auth/config tests

**Estimated scope:** Medium. If external auth enforcement belongs entirely in the reverse proxy/deployment config, keep app changes smaller but retain an executable fail-closed verification contract.

---

## T18: Define EvidenceBundle handoff, orchestration, and approval-mode contracts

**Description:** Add transport-independent domain/schema contracts for ChatGPT-originated project import, status, revision/hash-fenced edits, and explicit approval modes.

**Acceptance criteria:**
- [x] Handoff input validates creator/topic/instructions, normalized EvidenceBundle, bounded idempotency key, and expected origin `chatgpt_mcp` where application-owned.
- [x] Status/output contract exposes only bounded project/revision/progress/failure/evidence/draft/output metadata needed by ChatGPT.
- [x] Draft edit contract requires project ID, current revision ID, expected payload hash, and a locally valid structured draft.
- [x] Approval mode vocabulary is exactly `user_reviewed | delegated_e2e` for this milestone.
- [x] Delegated authorization data is bounded/auditable and cannot contain arbitrary full conversation history.
- [x] Stable error codes exist for auth failure, stale revision/hash, idempotency conflict, delegated-approval blocked, and invalid integration input.

**Verification:**
- [x] Focused schema/domain tests cover valid/invalid handoff, bounded keys, unknown fields, approval modes, stale edit inputs, and oversized audit context.
- [x] Existing draft/evidence schemas remain backward-compatible.
- [x] `npm test`
- [x] `npm run lint`

**Dependencies:** T17

**Files likely touched:**
- `domain/schemas.mjs`
- `domain/errors.mjs`
- `mcp/schemas/*` or shared schema module
- focused domain/schema tests

**Estimated scope:** Medium (3-5 files)

---

## T19: Add durable integration idempotency, import origin, and approval provenance

**Description:** Add the minimum forward-only SQLite/repository support needed to make remote retries safe and approval origin auditable across restarts.

**Acceptance criteria:**
- [x] Forward migration preserves all existing projects/revisions/sources/stages/artifacts.
- [x] One authenticated integration/idempotency key maps deterministically to one project/result; duplicate create requests cannot create a second project.
- [x] Imported project/research origin `chatgpt_mcp` survives close/reopen.
- [x] Approval persistence distinguishes actor/origin and `user_reviewed` vs `delegated_e2e`, bound to the approved revision/hash/timestamp.
- [x] No service token, provider key, full conversation, or unrelated sensitive content is stored.
- [x] Existing approved revision immutability and edit-vs-descendant serialization remain unchanged.

**Verification:**
- [x] Migration test from current schema version to the new version.
- [x] Repository reopen test for integration key/origin/approval provenance.
- [x] Duplicate idempotency-key race test proves exactly one durable project.
- [x] Existing storage/jobs/approval integration tests remain green.
- [x] `npm run db:migrate` against a temp DB.
- [x] `npm test`
- [x] `npm run lint`

**Dependencies:** T18

**Files likely touched:**
- `storage/migrations/003_chatgpt_handoff.sql`
- `storage/db.mjs`
- storage/integration tests
- possibly one domain/storage helper

**Estimated scope:** Medium (3-4 files)

---

## T20: Implement authenticated backend EvidenceBundle import -> research_ready -> generation

**Description:** Add the backend vertical slice that receives an already-normalized EvidenceBundle through the private integration boundary, revalidates it, persists application-owned source/evidence state, records imported research completion, and queues the existing generation stage without rerunning backend research.

**Acceptance criteria:**
- [x] Integration request is authenticated with the MCP service credential before mutation.
- [x] EvidenceBundle is revalidated at the backend trust boundary; malformed/empty invalid input fails closed.
- [x] Application creates/reuses exactly one project by integration idempotency key.
- [x] Persisted source/evidence records retain normalized provenance/conflict/stat information needed by current generation/review flows.
- [x] Project origin/imported research state survives restart and is distinguishable from provider-executed research.
- [x] Imported project reaches `research_ready` and queues the existing durable generation stage.
- [x] Backend OpenAI research provider is not called for imported projects.
- [x] Existing generation service receives only application-owned normalized source/evidence records.

**Verification:**
- [x] RED integration test initially proves import route/service missing.
- [x] Success test: import -> `research_ready`/generation queued.
- [x] Spy/fake provider test proves research provider call count remains zero.
- [x] Reopen test proves evidence/origin/idempotency survives DB close/reopen.
- [x] Duplicate request test returns the same project and no duplicate generation stage.
- [x] Invalid service credential and invalid EvidenceBundle tests make zero durable mutation.
- [x] `npm test`
- [x] `npm run lint`

**Dependencies:** T19

**Files likely touched:**
- `app/services/import-research.mjs`
- `app/http/integrations.mjs`
- `app/http/router.mjs`
- `app/server.mjs`
- focused integration tests

**Estimated scope:** Medium. If this exceeds five files, split route wiring from service/storage behavior into adjacent commits while preserving one vertical acceptance checkpoint.

---

## T21: Add MCP backend client plus `create_video_project` and `get_video_project`

**Description:** Connect authenticated Bright Evidence MCP to the private Bright Profile integration API and expose the first usable ChatGPT orchestration slice.

**Acceptance criteria:**
- [x] MCP backend client uses only configured private backend URL + service credential, bounded timeout, sanitized stable errors, and no automatic broad retries for mutation calls beyond explicit idempotent semantics.
- [x] `create_video_project` validates handoff input and returns bounded project identity/status without embedding backend secrets/raw errors.
- [x] `get_video_project` is read-only and returns bounded project status/current revision/progress/failure/evidence/draft/output metadata.
- [x] `create_video_project` is not marked read-only and does not claim to be destructive if it is an idempotent create/import action.
- [x] `get_video_project` is annotated read-only.
- [x] MCP does not open SQLite or artifact paths directly.
- [x] Existing `normalize_evidence` contract/output remains unchanged.

**Verification:**
- [x] RED tool-list/tool-call tests for missing new tools.
- [x] Tool schema tests validate advertised input/output contracts.
- [x] Integration test: normalize-compatible bundle -> MCP create -> backend project -> MCP get.
- [x] Backend auth failure becomes sanitized MCP error.
- [x] Duplicate create call with same idempotency key returns same project.
- [x] Existing MCP health/body/deadline/rate-limit/Host/Origin tests remain green.
- [x] `npm test`
- [x] `npm run lint`

**Dependencies:** T17, T20

**Files likely touched:**
- `mcp/backend-client.mjs`
- `mcp/server.mjs`
- `mcp/schemas/*`
- MCP/integration tests

**Estimated scope:** Medium (3-5 files)

---

### Checkpoint A — Authenticated import boundary

Do not continue to approval tools unless all are proven:

- [x] unauthenticated/invalidly authenticated write access fails closed;
- [x] MCP->backend credential is required and secret-safe;
- [x] backend revalidates EvidenceBundle;
- [x] imported project does not call backend research provider;
- [x] imported evidence/origin survives reopen;
- [x] repeated create requests are idempotent;
- [x] `create_video_project` and `get_video_project` work through the real internal API boundary;
- [x] existing standalone and MCP read-only behavior remains green.

---

## T22: Add ChatGPT draft editing and `user_reviewed` approval path

**Description:** Extend the orchestration surface so the default ChatGPT flow can present, edit, and explicitly approve the current review draft while reusing existing backend revision/approval rules.

**Acceptance criteria:**
- [x] Review-relevant `get_video_project` response contains the bounded current draft, revision ID, and payload hash.
- [x] `edit_video_draft` requires the expected current revision/hash and a valid structured draft.
- [x] Stale revision/hash edit fails without mutation.
- [x] Existing draft schema/source-reference/timeline/render validation remains authoritative.
- [x] `approve_video_project(mode=user_reviewed)` requires `review_required`, exact current revision/hash, and existing approval validation.
- [x] Default orchestration never calls approval/render merely because generation completed; the product contract still stops at review until the user approves/continues.

**Verification:**
- [x] RED tests for missing edit/approve tools.
- [x] Edit success + persistence + reopen test.
- [x] Stale-hash/revision negative tests.
- [x] Unknown source/invalid timeline/render-setting edit tests make no mutation.
- [x] User-reviewed approval success and existing unverified-claim/override behavior remain correct.
- [x] Default flow integration test reaches `review_required` and proves no approval descendant stage exists.
- [x] `npm test`
- [x] `npm run lint`

**Dependencies:** T18, T19, T21

**Files likely touched:**
- `mcp/server.mjs`
- `mcp/schemas/*`
- `app/services/approve-project.mjs`
- relevant HTTP/integration client layer
- focused tests

**Estimated scope:** Medium

---

## T23: Implement server-gated delegated end-to-end approval

**Description:** Add the explicit `delegated_e2e` approval mode for requests where the authenticated user has asked ChatGPT to run the full pipeline, while preventing prompt-only/model-only bypasses.

**Acceptance criteria:**
- [x] Delegated approval is represented durably as a distinct approval mode/origin from `user_reviewed`.
- [x] Backend requires exact `review_required` project/current revision/current payload hash.
- [x] Backend requires at least one retained evidence item.
- [x] Backend rejects any unresolved evidence conflict for delegated approval.
- [x] Backend revalidates draft schema/source references/timeline/render settings before delegated approval.
- [x] Model-provided `verified`, override text, or tool arguments alone cannot create delegated authorization.
- [x] Authenticated integration request must carry bounded delegated-E2E authorization context/state; missing/invalid delegated authorization fails closed.
- [x] Terminal/non-retryable workflow state cannot be bypassed by delegated approval.
- [x] Existing revision immutability and descendant-stage barrier remain unchanged.

**Verification:**
- [x] RED delegated-approval tests before implementation.
- [x] Clean conflict-free valid project succeeds and persists `delegated_e2e` provenance.
- [x] Conflict group blocks approval.
- [x] Zero retained evidence blocks approval.
- [x] Invalid/stale draft/revision/hash blocks approval.
- [x] Fake/model `verified: true` without delegated authorization remains insufficient.
- [x] Audit context is bounded and contains no secret/full conversation.
- [x] Reopen test preserves approval mode/origin/revision/hash.
- [x] `npm test`
- [x] `npm run lint`

**Dependencies:** T18, T19, T21

**Files likely touched:**
- `app/services/approve-project.mjs`
- storage/repository approval persistence
- MCP approval schema/handler
- delegated-approval tests

**Estimated scope:** Medium

---

### Checkpoint B — Review and approval boundary

Do not continue to full automated production controls unless all are proven:

- [x] default flow stops at `review_required`;
- [x] edit/approval are revision/hash fenced;
- [x] `user_reviewed` and `delegated_e2e` are durable and distinct;
- [x] conflicts, zero retained evidence, invalid drafts, stale state, or missing delegated authorization block delegated approval;
- [x] model/source content cannot grant approval authority;
- [x] existing approval/descendant race invariants remain green.

---

## T24: Expose render, retry, and cancel through MCP using existing durable controls

**Description:** Complete the ChatGPT orchestration control surface without duplicating state-machine logic in MCP.

**Acceptance criteria:**
- [x] `start_video_render` calls the existing backend render-start transaction only for the current approved revision.
- [x] Repeated render-start for the same active/current approved revision does not create duplicate descendant stages.
- [x] `retry_video_project` is legal only when the backend durable state marks the current failed stage retryable; repeated retry while replacement work is queued/running remains idempotent.
- [x] `cancel_video_project` is legal only for existing active/cancelled semantics and preserves current fencing/idempotency behavior.
- [x] MCP status after render/retry/cancel reflects backend durable truth, not local MCP assumptions.
- [x] Tools return stable sanitized error codes/messages.

**Verification:**
- [x] Render-start success/idempotency/illegal-state tests.
- [x] Retryable vs non-retryable failure tests.
- [x] Repeated retry no-duplicate test.
- [x] Cancel + repeated-cancel + stale-owner fencing integration test.
- [x] Existing standalone UI/API controls remain green.
- [x] `npm test`
- [x] `npm run lint`

**Dependencies:** T21, T22, T23

**Files likely touched:**
- `mcp/server.mjs`
- `mcp/schemas/*`
- backend integration control endpoint/client
- focused orchestration tests

**Estimated scope:** Medium

---

## T25: Implement short-lived authoritative MP4 delivery for ChatGPT

**Description:** Provide a narrow, signed, expiring download capability that lets ChatGPT give the user the completed authoritative MP4 without exposing arbitrary filesystem/artifact access.

**Acceptance criteria:**
- [x] Download capability is bound to the intended project + approved revision + authoritative output artifact.
- [x] Token is cryptographically signed/opaque and expires quickly; target expiry <= 15 minutes unless a documented verified constraint requires otherwise.
- [x] Caller cannot choose filesystem path or arbitrary artifact ID/path.
- [x] Current authoritative output size/hash/path checks are reused before/while serving.
- [x] Expired/tampered/wrong-project/wrong-revision token fails closed.
- [x] MP4 is streamed rather than buffered fully in MCP memory.
- [x] Secrets/signing keys are configuration/deployment secrets, not model-visible data.
- [x] Prefer stateless tokens; if persistence is added, justify and test revocation/cleanup semantics.

**Verification:**
- [x] Unit tests for sign/verify/expiry/tamper/binding.
- [x] Integration test serves current authoritative MP4 only.
- [x] Negative tests for arbitrary path/artifact selection.
- [x] Streaming test or bounded-memory contract where practical.
- [x] Existing standalone output endpoint validation tests remain green.
- [x] `npm test`
- [x] `npm run lint`
- [x] Security review of token/key/log handling.

**Dependencies:** T17, T19, T24

**Files likely touched:**
- `security/download-token.mjs`
- MCP/reverse-proxy-facing download handler
- backend artifact/output client path
- focused unit/integration tests

**Estimated scope:** Medium

---

## T26: Wire private runtime networking and structured integration observability

**Description:** Connect the MCP and standalone app deployments through the intended private network/service path and add enough structured telemetry to diagnose the multi-hop workflow without exposing secrets.

**Acceptance criteria:**
- [x] MCP can reach the integration API privately without publishing the worker or broadening standalone browser/API public exposure.
- [x] Existing standalone `127.0.0.1` browser boundary remains intentional and documented; integration traffic uses a distinct authenticated path/network policy.
- [x] MCP container still does not mount Bright data/artifact volumes.
- [x] Compose/deployment config passes the minimum service URL/auth/signing settings through secrets/environment without committing secret values.
- [x] Structured logs correlate MCP request ID -> idempotency key -> project -> revision/hash -> stage/attempt -> output artifact where applicable.
- [x] Logs include action/tool, state transition, approval mode, stable error code, duration/result where useful.
- [x] Logs exclude provider keys, integration tokens, signing keys, Google credentials, full conversations, and unnecessary raw source text.
- [x] Health/readiness semantics remain local and do not perform paid provider calls.

**Verification:**
- [x] `docker compose config`
- [x] `docker compose -f compose.mcp.yml config` or resulting combined-profile equivalent.
- [x] Build/start app+worker+MCP in the intended private topology.
- [x] Verify app health, MCP health, worker no published port, MCP no Bright data/artifact mount.
- [x] Verify authenticated MCP->app call succeeds and unauthenticated internal call fails.
- [x] Inspect representative structured logs for correlation and secret redaction.
- [x] `npm test`
- [x] `npm run lint`

**Dependencies:** T17, T21, T25

**Files likely touched:**
- `compose.yml`
- `compose.mcp.yml`
- `.env.example`
- integration logging/config modules
- deployment/runtime tests or CI checks

**Estimated scope:** Medium. If one shared Compose file/profile is introduced, keep migration reversible and document exact startup commands.

---

### Checkpoint C — Production/output boundary

Before final E2E, require:

- [x] render/retry/cancel use existing durable semantics;
- [x] repeated render-start cannot duplicate downstream work;
- [x] signed download cannot select arbitrary files and rejects expired/tampered tokens;
- [x] MCP/app communicate through the intended authenticated private path;
- [x] worker remains unexposed and MCP has no Bright storage mount;
- [x] browser Host/Origin boundary remains intact;
- [x] integration logging is correlated and secret-safe.

---

## T27: Add deterministic full E2E, restart, idempotency, and adversarial security regression

**Description:** Prove the complete new feature path using deterministic fakes for paid/non-deterministic provider steps, while exercising the failure/retry/concurrency/security cases most likely to regress.

**Acceptance criteria:**
- [x] Deterministic flow reaches authoritative downloadable MP4 from candidate evidence -> normalization -> import -> generation -> delegated approval -> media -> TTS -> render.
- [x] A separate default-mode integration flow reaches `review_required` and proves no approval/render occurs automatically.
- [x] Project/evidence/revision/approval state survives DB reopen at representative checkpoints.
- [x] Duplicate MCP create/render/retry calls do not duplicate project/stage/artifact work.
- [x] Unauthorized external/internal calls fail with zero durable mutation.
- [x] Conflict, zero evidence, invalid draft, stale hash, terminal failure, tampered/expired download token all fail closed.
- [x] Cancel/reclaim/stale-owner fencing remains authoritative after MCP wrapping.
- [x] Existing standalone full-flow regression remains green.

**Verification:**
- [x] Focused `node --test` integration/E2E file(s).
- [x] `npm test`
- [x] `npm run lint`
- [x] `npm run audit:standalone`
- [x] `npm run build:web`
- [x] `npm run render:smoke`
- [x] SQLite migration/reopen smoke.
- [x] MCP process/health/body/deadline/rate-limit regression.
- [x] Standalone app+worker Compose boundary regression.
- [x] MCP Compose/private-network boundary regression.

**Dependencies:** T20-T26

**Files likely touched:**
- `tests/integration/mcp-video-handoff.test.mjs`
- `tests/integration/mcp-video-e2e.test.mjs`
- test fakes/helpers
- CI workflow only if required to execute the new deterministic gates

**Estimated scope:** Medium. Split focused integration and full E2E files rather than creating one oversized test file.

---

## T28: Run live ChatGPT default-review and explicit-E2E acceptance; close docs/ship gates

**Description:** Exercise the actual authenticated ChatGPT MCP integration against the deployed backend and update repository documentation only from observed evidence.

**Acceptance criteria:**
- [ ] Live default-review run: ChatGPT researches public sources, actual `normalize_evidence` call occurs, actual `create_video_project` call occurs, backend reaches `review_required`, draft is shown, and no approval/render happens before user action.
- [ ] Live explicit-E2E run: user explicitly requests E2E, ChatGPT researches/normalizes/imports, generation completes, delegated approval is recorded, render completes, and user can access/play the authoritative MP4.
- [x] Evidence/logs prove imported project used the ChatGPT EvidenceBundle and did not rerun backend research.
- [ ] Actual auth/tool/runtime environment and deployed commit/image are recorded upon live run.
- [x] No secrets or sensitive conversation content are recorded in acceptance evidence.
- [x] Any defect found returns to debug -> focused regression/TDD -> fix -> review before acceptance continues.
- [x] Current status/integration docs are updated from "planned" to implemented truth for automated surface.
- [x] Existing issue #15 standalone browser smoke remains separate unless this milestone changes browser-facing behavior that requires reopening/expanding its gate.

**Verification:**
- [ ] Record actual ChatGPT tool calls and project IDs/status transitions during live acceptance.
- [ ] Record approval mode/provenance for both review modes during live acceptance.
- [ ] Verify completed download/playback during live acceptance.
- [x] Full current `Bright Profile Verification` workflow green on exact implementation head.
- [x] Security review: correctness -> security -> architecture -> simplicity -> performance.
- [ ] Project-wide Definition of Done checked.
- [x] Ship/rollback notes updated if deployment topology/auth changed materially.

**Dependencies:** T26, T27

**Files likely touched:**
- `docs/project-status.md`
- `docs/bright-evidence-plugin-internal.md`
- `docs/mcp-remote.md`
- `docs/specs/chatgpt-mcp-e2e-video-handoff.md`
- ship/acceptance evidence docs as needed

**Estimated scope:** Medium (docs/evidence after runtime acceptance)

---

## Final Definition of Done Gate

Do not mark the ChatGPT MCP E2E milestone complete until all are true:

- [x] T17-T27 implementation & verification acceptance criteria pass.
- [x] Authentication/authorization for write/cost-bearing MCP is proven fail-closed.
- [x] MCP has no direct SQLite/artifact-volume access.
- [x] Imported EvidenceBundle is backend-revalidated and does not trigger backend research.
- [ ] Default human-review behavior is live-verified on live ChatGPT client.
- [x] Delegated E2E approval is server-gated with trusted delegation grant, revision/hash-bound, conflict-free, and audit-distinct.
- [x] Retry/cancel/render idempotency/fencing remain correct through MCP.
- [x] Signed authoritative MP4 delivery cannot expose arbitrary files and validates exact capability binding.
- [x] New behavior has RED->GREEN tests and existing tests/build/lint/audits remain green.
- [x] Private runtime topology/observability are verified.
- [ ] Two live ChatGPT acceptance flows pass on the actual deployed integration.
- [x] Current docs describe implemented truth for code & test suites.
- [ ] Human review/approval of the implementation and ship evidence is complete.

