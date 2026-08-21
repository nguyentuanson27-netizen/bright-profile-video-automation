# Task List: ChatGPT MCP Temporary No-Auth Reset

Source: `docs/specs/chatgpt-mcp-e2e-video-handoff.md`, `tasks/plan.md`, and `docs/project-status.md`.

T01-T16 belong to the completed standalone MVP baseline and remain covered by `tasks/traceability.md`. This checklist retains T17-T28 for the ChatGPT MCP milestone but reopens the items affected by the 2026-08-21 no-auth scope reset.

## Reset Rules

- External ChatGPT -> MCP is intentionally `noauth` for this milestone.
- Private MCP -> Bright Profile remains authenticated with `BRIGHT_INTEGRATION_TOKEN`.
- OAuth/DCR/session/static external bearer auth is deferred.
- `delegated_e2e` is deferred.
- Current approval path is `user_reviewed` only.
- Existing Host/Origin/body/deadline/rate-limit/SSRF/artifact/fencing controls remain mandatory.
- Do not mark live/runtime gates complete from unit/integration tests alone.

---

## T17 — Reset external MCP boundary to explicit noauth

**Status:** REOPENED

- [ ] `/mcp` initialize works without `Authorization`.
- [ ] `tools/list` works without `Authorization`.
- [ ] legal tool calls work without external bearer/OAuth token.
- [ ] all active MCP tools advertise `securitySchemes: [{type: 'noauth'}]`.
- [ ] external OAuth/static bearer dispatch/fallback logic is removed from active MCP request handling.
- [ ] Host/Origin checks remain enabled.
- [ ] request body size limit remains enabled.
- [ ] request deadline remains enabled.
- [ ] rate limit remains enabled.
- [ ] structured logging remains secret-safe.
- [ ] `BRIGHT_INTEGRATION_TOKEN` remains required for MCP -> app.
- [ ] missing/wrong backend service token fails with zero durable mutation.

**Verification:**

- [ ] focused noauth transport tests RED -> GREEN;
- [ ] direct backend service-auth negative tests;
- [ ] existing body/deadline/rate-limit/Host/Origin regressions green.

---

## T18 — Simplify handoff/approval schema for noauth mode

**Status:** REOPENED

- [ ] `approve_video_project` public MCP input no longer exposes caller-selectable `mode`.
- [ ] public MCP input no longer exposes caller-selectable `approvalActor`.
- [ ] public MCP input no longer exposes `delegationGrant`.
- [ ] public MCP input no longer exposes `delegatedContext`.
- [ ] MCP adapter maps approval to `mode=user_reviewed` internally.
- [ ] audit actor/origin is a bounded integration-origin value, not a claimed authenticated human identity.
- [ ] revision ID + expected payload hash remain required.
- [ ] current draft/source/schema legality checks remain authoritative.

**Verification:**

- [ ] schema rejects removed/deferred fields;
- [ ] stale revision/hash regression green;
- [ ] valid user-reviewed approval regression green.

---

## T19 — Retain durable ChatGPT handoff storage

**Status:** IMPLEMENTED BASELINE; RESET RE-VERIFY REQUIRED

- [x] schema v3 stores `origin=chatgpt_mcp`.
- [x] schema v3 stores integration idempotency key.
- [x] schema v3 stores approval mode/actor/context fields.
- [x] migration/reopen coverage exists.
- [ ] no new destructive migration is introduced merely to remove deferred OAuth/delegation behavior.
- [ ] active runtime no longer depends on persisted OAuth client/session/token state.
- [ ] exact-head migration/reopen checks pass after reset.

---

## T20 — Retain service-authenticated EvidenceBundle import

**Status:** IMPLEMENTED BASELINE; RESET RE-VERIFY REQUIRED

- [x] backend revalidates imported EvidenceBundle.
- [x] imported project persists application-owned evidence/source provenance.
- [x] imported origin is `chatgpt_mcp`.
- [x] same idempotency key maps to the same project.
- [x] imported project skips backend research provider.
- [x] imported project reaches `research_ready` and queues generation.
- [ ] direct calls without valid `BRIGHT_INTEGRATION_TOKEN` fail closed with zero mutation after noauth reset.
- [ ] exact-head import/reopen/idempotency regressions remain green.

---

## T21 — Convert MCP tools to noauth transport

**Status:** REOPENED

- [ ] `normalize_evidence` uses `noauth` security metadata.
- [ ] `create_video_project` uses `noauth` security metadata.
- [ ] `get_video_project` uses `noauth` security metadata.
- [ ] `edit_video_draft` uses `noauth` security metadata.
- [ ] `approve_video_project` uses `noauth` security metadata.
- [ ] `start_video_render` uses `noauth` security metadata.
- [ ] `retry_video_project` uses `noauth` security metadata.
- [ ] `cancel_video_project` uses `noauth` security metadata.
- [ ] OAuth scope checks are removed from active MCP handlers.
- [ ] synthetic authenticated-user context is removed.
- [ ] MCP -> backend correlation IDs remain propagated.
- [ ] backend client remains private/service-authenticated.

### Checkpoint A

- [ ] no Authorization -> initialize succeeds;
- [ ] no Authorization -> tools/list succeeds;
- [ ] no Authorization -> legal write tool reaches backend;
- [ ] direct backend no token/wrong token -> reject;
- [ ] Host/body/deadline/rate-limit controls remain green.

---

## T22 — Review/edit/user-reviewed approval path

**Status:** REOPENED FOR CONTRACT CLEANUP

- [x] project status can expose current draft/revision/hash.
- [x] draft edits are revision/hash fenced.
- [x] backend user-reviewed approval path exists.
- [ ] ChatGPT flow is explicitly documented/tested to stop at `review_required`.
- [ ] no approval/render/downstream stage occurs before user confirmation.
- [ ] `approve_video_project` only produces `user_reviewed` approval in the active MCP milestone.
- [ ] caller cannot select actor/mode/delegation state.
- [ ] stale/illegal approval remains fail-closed.
- [ ] downstream-started edit lock remains authoritative.

---

## T23 — Defer delegated E2E authorization

**Status:** REOPENED / FEATURE DEFERRED

- [ ] remove `delegated_e2e` from active MCP input contract.
- [ ] remove/deactivate delegation grant issuance from current supported flow.
- [ ] remove/deactivate delegation grant verification from current supported flow.
- [ ] remove loopback `/api/projects/:id/delegation-grant` if no retained supported caller exists.
- [ ] remove `delegationGrant`/`delegatedContext` active runtime handling.
- [ ] remove delegated positive-path E2E/tests from current milestone.
- [ ] remove stale docs/status/PR claims that delegated E2E is implemented/verified.
- [ ] keep DB approval columns if removing them would create unnecessary migration churn.

### Checkpoint B

- [ ] model/tool input cannot create trusted user identity;
- [ ] model/tool input cannot choose delegated approval;
- [ ] default flow stops at `review_required`;
- [ ] valid user-reviewed approval works.

---

## T24 — Render/retry/cancel controls

**Status:** IMPLEMENTED BASELINE; RESET RE-VERIFY REQUIRED

- [x] render-start wrapper exists.
- [x] duplicate active render-start is idempotent.
- [x] retry wraps durable backend retry semantics.
- [x] cancel wraps durable backend cancellation/fencing semantics.
- [ ] no external-auth assumption remains in these MCP wrappers.
- [ ] exact-head render/retry/cancel regressions remain green.

---

## T25 — Signed authoritative MP4 delivery

**Status:** IMPLEMENTED BASELINE; RESET RE-VERIFY REQUIRED

- [x] signed download token binds project/revision/artifact.
- [x] expiration/tamper checks exist.
- [x] authoritative output metadata/file integrity is checked.
- [x] public MCP proxy requires signed capability token.
- [x] proxy streams output rather than buffering full MP4.
- [x] timeout/backpressure controls exist.
- [ ] no OAuth/static external bearer dependency remains in completed-output delivery.
- [ ] exact-head valid/wrong-project/wrong-revision/wrong-artifact/expired/tampered tests pass.

---

## T26 — Remove OAuth/DCR deployment/config/runtime state

**Status:** REOPENED

Remove from active runtime/config:

- [ ] `MCP_AUTH_TOKEN`.
- [ ] `MCP_OAUTH_SECRET`.
- [ ] `BRIGHT_USER_AUTH_SECRET`.
- [ ] `MCP_CLIENT_STORAGE_PATH`.
- [ ] OAuth client-storage named volume.
- [ ] OAuth/DCR/session routes and discovery metadata.
- [ ] `security/oauth.mjs`.
- [ ] OAuth-specific integration tests.

Keep/verify:

- [ ] `MCP_PUBLIC_URL`.
- [ ] `MCP_ALLOWED_HOSTS`.
- [ ] `MCP_MAX_BODY_BYTES`.
- [ ] `MCP_RATE_LIMIT_PER_MINUTE`.
- [ ] `MCP_REQUEST_TIMEOUT_MS`.
- [ ] `BRIGHT_BACKEND_URL`.
- [ ] `BRIGHT_INTEGRATION_TOKEN`.
- [ ] MCP has no Bright SQLite/artifact mount.
- [ ] worker publishes no port.
- [ ] MCP host publication remains intentionally constrained.
- [ ] private MCP -> app network path works.
- [ ] request correlation remains secret-safe.

---

## T27 — Deterministic noauth full E2E + adversarial regression

**Status:** REOPENED

Required positive path:

- [ ] start app + MCP.
- [ ] initialize MCP without Authorization.
- [ ] `normalize_evidence`.
- [ ] `create_video_project`.
- [ ] generation completes.
- [ ] `get_video_project` reaches `review_required`.
- [ ] prove zero approval before user action.
- [ ] prove zero downstream media/render before user action.
- [ ] `approve_video_project` records `user_reviewed`.
- [ ] `start_video_render`.
- [ ] media ingest completes.
- [ ] TTS completes.
- [ ] render completes.
- [ ] project reaches `completed`.
- [ ] signed MP4 downloads and validates.

Required adversarial/recovery coverage:

- [ ] duplicate create/render/retry calls do not duplicate durable work;
- [ ] DB reopen/restart retains representative state;
- [ ] stale edit/approval rejected;
- [ ] direct backend no/wrong service token rejected with zero mutation;
- [ ] retry/cancel/stale-owner fencing retained;
- [ ] signed-download expired/tampered/wrong-binding cases fail closed;
- [ ] prompt-injection-looking source text remains inert data;
- [ ] old OAuth/delegated setup is absent from the E2E harness.

Verification:

- [ ] focused E2E test green;
- [ ] `npm test` green;
- [ ] `npm run lint` green;
- [ ] `npm run audit:standalone` green;
- [ ] `npm run build:web` green;
- [ ] `npm run render:smoke` green;
- [ ] standalone Compose boundary green;
- [ ] MCP Compose boundary green.

---

## T28 — Live ChatGPT noauth acceptance and documentation closure

**Status:** OPEN — LIVE ACCEPTANCE REQUIRED

### Live Path A — stop at review

- [ ] deploy exact implementation HEAD/image.
- [ ] connect ChatGPT without OAuth linking/auth setup.
- [ ] actual `normalize_evidence` tool call occurs.
- [ ] actual `create_video_project` tool call occurs.
- [ ] backend reaches `review_required`.
- [ ] draft/evidence is shown in ChatGPT.
- [ ] no approval occurs before user confirmation.
- [ ] no render/downstream work starts before user confirmation.

### Live Path B — user-reviewed completion

- [ ] user reviews/confirms in ChatGPT.
- [ ] actual `approve_video_project` call occurs.
- [ ] durable approval mode is `user_reviewed`.
- [ ] actual `start_video_render` call occurs.
- [ ] render completes.
- [ ] final authoritative MP4 is retrievable.
- [ ] final MP4 is playable.

### Evidence/closure

- [ ] record exact HEAD/image/environment.
- [ ] record project IDs/status transitions/tool calls without secrets.
- [ ] record approval provenance.
- [ ] record completed download/playback evidence.
- [ ] full exact-head `Bright Profile Verification` workflow green.
- [ ] project-wide Definition of Done checked.
- [ ] `docs/project-status.md` updated from observed truth.
- [ ] `tasks/traceability.md` closure audit updated from observed truth.
- [ ] PR body updated to remove stale OAuth/delegated claims and report actual test counts.

---

## Final Definition of Done for This Reset

Do not mark the milestone complete until all are true:

- [ ] external ChatGPT -> MCP is one coherent `noauth` contract;
- [ ] OAuth/DCR/session/static external bearer code/config is absent from the active milestone;
- [ ] private MCP -> Bright Profile service authentication remains fail-closed;
- [ ] `delegated_e2e` is deferred and unreachable from the active MCP contract;
- [ ] `user_reviewed` is the only active MCP approval mode;
- [ ] deterministic noauth E2E passes;
- [ ] exact-head CI passes;
- [ ] live ChatGPT noauth Path A and Path B pass;
- [ ] docs and PR body describe only observed current truth.
