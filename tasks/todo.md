# Task List: ChatGPT MCP Temporary No-Auth Reset

Source: `docs/specs/chatgpt-mcp-e2e-video-handoff.md`, `tasks/plan.md`, and `docs/project-status.md`.

T01-T16 belong to the completed standalone MVP baseline and remain covered by `tasks/traceability.md`. This checklist retains T17-T28 for the ChatGPT MCP milestone but reopens the items affected by the 2026-08-21 no-auth scope reset.

## Reset Rules

- External ChatGPT -> MCP is intentionally `noauth` for this milestone.
- Private MCP -> Bright Profile remains authenticated with `BRIGHT_INTEGRATION_TOKEN`.
- OAuth/DCR/session/static external bearer auth is deferred.
- `delegated_e2e` is deferred.
- Current approval semantic is **external review acknowledgment**, not authenticated human review.
- If storage retains `approval_mode='user_reviewed'`, it is a legacy compatibility label only and must not be treated as proof of human identity/review.
- Anonymous writes are disabled by default and may be enabled only in a bounded acceptance/test window.
- Existing Host/Origin/body/deadline/rate-limit/SSRF/artifact/fencing controls remain mandatory.
- New no-auth kill-switch and bounded capacity controls are mandatory.
- Do not mark live/runtime gates complete from unit/integration tests alone.

---

## T17 — Reset external MCP boundary to explicit noauth

**Status:** REOPENED

- [ ] `/mcp` initialize works without `Authorization`.
- [ ] `tools/list` works without `Authorization`.
- [ ] legal tool calls require no external bearer/OAuth token.
- [ ] all active MCP tools advertise `securitySchemes: [{type: 'noauth'}]`.
- [ ] external OAuth/static bearer dispatch/fallback logic is removed from active MCP request handling.
- [ ] Host/Origin checks remain enabled.
- [ ] request body size limit remains enabled.
- [ ] request deadline remains enabled.
- [ ] rate limit remains enabled.
- [ ] structured logging remains secret-safe.
- [ ] `BRIGHT_INTEGRATION_TOKEN` remains required for MCP -> app.
- [ ] missing/wrong backend service token fails with zero durable mutation.
- [ ] `MCP_NOAUTH_WRITE_ENABLED=false` is the default.
- [ ] disabled write/cost-bearing tools fail with `NOAUTH_WRITE_DISABLED` before backend side effects.
- [ ] `MCP_MAX_INFLIGHT_WRITE_REQUESTS` is finite; target default `2`.
- [ ] `MCP_MAX_ACTIVE_PROJECTS` is finite; target default `3`.
- [ ] `MCP_RATE_LIMIT_PER_MINUTE` is finite; target default `20`.

**Verification:**

- [ ] focused noauth transport tests RED -> GREEN;
- [ ] kill-switch zero-mutation regressions;
- [ ] rate/in-flight/active-project capacity regressions;
- [ ] direct backend service-auth negative tests;
- [ ] existing body/deadline/rate-limit/Host/Origin regressions green.

---

## T18 — Simplify handoff/approval schema for noauth mode

**Status:** REOPENED

- [ ] `approve_video_project` public MCP input no longer exposes caller-selectable `mode`.
- [ ] public MCP input no longer exposes caller-selectable `approvalActor`.
- [ ] public MCP input no longer exposes `delegationGrant`.
- [ ] public MCP input no longer exposes `delegatedContext`.
- [ ] MCP/integration semantics call the result `external_review_acknowledged`.
- [ ] audit actor/origin is a bounded integration-origin value such as `chatgpt_mcp_noauth`, not a claimed authenticated human identity.
- [ ] if backend schema still persists `approval_mode='user_reviewed'`, the mapping to external review acknowledgment is explicit.
- [ ] responses/logs/tests/docs do not call the legacy storage value authenticated human-review proof.
- [ ] revision ID + expected payload hash remain required.
- [ ] current draft/source/schema legality checks remain authoritative.

**Verification:**

- [ ] schema rejects removed/deferred fields;
- [ ] stale revision/hash regression green;
- [ ] valid external review acknowledgment regression green;
- [ ] no assertion equates legacy `user_reviewed` with authenticated human identity/review.

---

## T19 — Retain durable ChatGPT handoff storage

**Status:** IMPLEMENTED BASELINE; RESET RE-VERIFY REQUIRED

- [x] schema v3 stores `origin=chatgpt_mcp`.
- [x] schema v3 stores integration idempotency key.
- [x] schema v3 stores approval mode/actor/context fields.
- [x] migration/reopen coverage exists.
- [ ] no new destructive migration is introduced merely to remove deferred OAuth/delegation behavior or rename the compatibility approval enum.
- [ ] active runtime no longer depends on persisted OAuth client/session/token state.
- [ ] legacy `user_reviewed` compatibility semantics are documented if retained.
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
- [ ] new create is rejected with `NOAUTH_CAPACITY_REACHED` when the configured non-terminal ChatGPT-origin project cap is reached.
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
- [ ] all mutating tools pass through write-enable + in-flight capacity gate before backend dispatch.

### Checkpoint A

- [ ] no Authorization -> initialize succeeds;
- [ ] no Authorization -> tools/list succeeds;
- [ ] writes disabled -> write tool fails with zero mutation;
- [ ] writes enabled -> legal write tool reaches backend;
- [ ] direct backend no token/wrong token -> reject;
- [ ] Host/body/deadline/rate-limit/capacity controls remain green.

---

## T22 — Review/edit/external-review-acknowledgment path

**Status:** REOPENED FOR CONTRACT CLEANUP

- [x] project status can expose current draft/revision/hash.
- [x] draft edits are revision/hash fenced.
- [x] backend approval path exists.
- [ ] backend-driven flow is explicitly documented/tested to stop at `review_required`.
- [ ] backend itself never auto-approves or starts downstream work at `review_required`.
- [ ] live ChatGPT Path A proves the tested client does not invoke approval/render before user confirmation.
- [ ] `approve_video_project` records external review acknowledgment semantics.
- [ ] caller cannot select actor/mode/delegation state.
- [ ] stale/illegal approval remains fail-closed.
- [ ] downstream-started edit lock remains authoritative.
- [ ] no audit/log/API claim says the noauth backend authenticated the human reviewer.

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
- [ ] backend stops at `review_required`;
- [ ] valid external review acknowledgment works when writes are enabled;
- [ ] no server claim equates acknowledgment with authenticated human proof.

---

## T24 — Render/retry/cancel controls

**Status:** IMPLEMENTED BASELINE; RESET RE-VERIFY REQUIRED

- [x] render-start wrapper exists.
- [x] duplicate active render-start is idempotent.
- [x] retry wraps durable backend retry semantics.
- [x] cancel wraps durable backend cancellation/fencing semantics.
- [ ] no external-auth assumption remains in these MCP wrappers.
- [ ] write kill-switch applies before render/retry/cancel backend mutation.
- [ ] in-flight write cap applies to mutating wrappers.
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

## T26 — Remove OAuth/DCR deployment/config/runtime state and add bounded noauth guardrails

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

Keep/add/verify:

- [ ] `MCP_PUBLIC_URL`.
- [ ] `MCP_ALLOWED_HOSTS`.
- [ ] `MCP_MAX_BODY_BYTES`.
- [ ] `MCP_REQUEST_TIMEOUT_MS`.
- [ ] `BRIGHT_BACKEND_URL`.
- [ ] `BRIGHT_INTEGRATION_TOKEN`.
- [ ] `MCP_NOAUTH_WRITE_ENABLED=false`.
- [ ] `MCP_RATE_LIMIT_PER_MINUTE=20` default or stricter finite value.
- [ ] `MCP_MAX_INFLIGHT_WRITE_REQUESTS=2` default or stricter finite value.
- [ ] `MCP_MAX_ACTIVE_PROJECTS=3` default or stricter finite value.
- [ ] MCP has no Bright SQLite/artifact mount.
- [ ] worker publishes no port.
- [ ] standalone app remains private/loopback-oriented.
- [ ] remote ChatGPT access is through intended HTTPS MCP ingress/reverse proxy only.
- [ ] private MCP -> app network path works.
- [ ] request correlation remains secret-safe.
- [ ] no noauth limit defaults to unlimited.

---

## T27 — Deterministic noauth full E2E + adversarial regression

**Status:** REOPENED

Required positive path:

- [ ] start app + MCP.
- [ ] initialize MCP without Authorization.
- [ ] prove writes are disabled by default.
- [ ] start test instance/config with writes explicitly enabled.
- [ ] `normalize_evidence`.
- [ ] `create_video_project`.
- [ ] generation completes.
- [ ] `get_video_project` reaches `review_required`.
- [ ] prove zero backend auto-approval before explicit tool invocation.
- [ ] prove zero downstream media/render before explicit approval/render tool calls.
- [ ] test harness invokes `approve_video_project`.
- [ ] external review acknowledgment is recorded; any legacy `user_reviewed` storage value is treated only as compatibility representation.
- [ ] `start_video_render`.
- [ ] media ingest completes.
- [ ] TTS completes.
- [ ] render completes.
- [ ] project reaches `completed`.
- [ ] signed MP4 downloads and validates.

Required adversarial/recovery coverage:

- [ ] write kill-switch returns `NOAUTH_WRITE_DISABLED` with zero mutation;
- [ ] configured rate limit is enforced;
- [ ] configured in-flight write cap is enforced;
- [ ] configured active-project cap returns `NOAUTH_CAPACITY_REACHED` with no extra project;
- [ ] duplicate create/render/retry calls do not duplicate durable work;
- [ ] DB reopen/restart retains representative state;
- [ ] stale edit/approval rejected;
- [ ] direct backend no/wrong service token rejected with zero mutation;
- [ ] retry/cancel/stale-owner fencing retained;
- [ ] signed-download expired/tampered/wrong-binding cases fail closed;
- [ ] prompt-injection-looking source text remains inert data;
- [ ] old OAuth/delegated setup is absent from the E2E harness;
- [ ] deterministic test does not claim it proves real human review.

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

### Acceptance-window setup

- [ ] deploy exact implementation HEAD/image.
- [ ] remote MCP ingress is intentionally enabled for the bounded acceptance window.
- [ ] `MCP_NOAUTH_WRITE_ENABLED=true` is set explicitly for the window.
- [ ] configured rate/in-flight/active-project limits are recorded.
- [ ] standalone app itself remains private.

### Live Path A — stop at review

- [ ] connect ChatGPT without OAuth linking/auth setup.
- [ ] actual `normalize_evidence` tool call occurs.
- [ ] actual `create_video_project` tool call occurs.
- [ ] backend reaches `review_required`.
- [ ] draft/evidence is shown in ChatGPT.
- [ ] ChatGPT does not invoke approval before user confirmation.
- [ ] ChatGPT does not invoke render/downstream start before user confirmation.
- [ ] evidence is described as tested-client behavior, not a universal server guarantee against anonymous callers.

### Live Path B — review-acknowledged completion

- [ ] user explicitly confirms/continues in ChatGPT.
- [ ] actual `approve_video_project` call occurs.
- [ ] durable audit is described as external review acknowledgment.
- [ ] if storage contains `approval_mode='user_reviewed'`, evidence labels it as legacy compatibility data, not authenticated human proof.
- [ ] actual `start_video_render` call occurs.
- [ ] render completes.
- [ ] final authoritative MP4 is retrievable.
- [ ] final MP4 is playable.

### Acceptance-window teardown

- [ ] `MCP_NOAUTH_WRITE_ENABLED=false` is restored and/or remote ingress is withdrawn.
- [ ] disable/withdraw timestamp is recorded.
- [ ] noauth write surface is not left always-on by default after acceptance.

### Evidence/closure

- [ ] record exact HEAD/image/environment.
- [ ] record project IDs/status transitions/tool calls without secrets.
- [ ] record bounded approval provenance without claiming authenticated human identity.
- [ ] record configured noauth limits and write-window enable/disable times.
- [ ] record completed download/playback evidence.
- [ ] full exact-head `Bright Profile Verification` workflow green.
- [ ] project-wide Definition of Done checked.
- [ ] `docs/project-status.md` updated from observed truth.
- [ ] `tasks/traceability.md` closure audit updated from observed truth.
- [ ] PR body updated to report actual test counts and truthful noauth approval semantics.

---

## Final Definition of Done for This Reset

Do not mark the milestone complete until all are true:

- [ ] external ChatGPT -> MCP is one coherent `noauth` contract;
- [ ] OAuth/DCR/session/static external bearer code/config is absent from the active milestone;
- [ ] private MCP -> Bright Profile service authentication remains fail-closed;
- [ ] anonymous writes are disabled by default;
- [ ] rate/in-flight/active-project caps are finite and enforced;
- [ ] `delegated_e2e` is deferred and unreachable from the active MCP contract;
- [ ] approval is represented as external review acknowledgment, not authenticated human proof;
- [ ] deterministic noauth E2E passes without claiming human-review proof;
- [ ] exact-head CI passes;
- [ ] live ChatGPT noauth Path A and Path B pass;
- [ ] write window is disabled/withdrawn after live acceptance;
- [ ] docs and PR body describe only observed current truth.
