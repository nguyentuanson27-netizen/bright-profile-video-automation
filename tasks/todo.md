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
- No-auth kill switch and finite edge capacity controls are mandatory.
- `MCP_MAX_ACTIVE_PROJECTS` is a **durable backend invariant**, not a process-local MCP precheck.
- T28 teardown requires **both** write disable and external MCP ingress withdrawal.
- T28 Path A requires a complete ChatGPT-supplied structured draft and does not use backend generation or `OPENAI_API_KEY`.
- Omitting `draft` retains a backend-generation compatibility path only; it is not valid T28 acceptance evidence.
- Do not mark live/runtime gates complete from unit/integration tests alone.

---

## T17 — Reset external MCP boundary to explicit noauth

**Status:** COMPLETED & CI-VERIFIED

- [x] `/mcp` initialize works without `Authorization`.
- [x] `tools/list` works without `Authorization`.
- [x] legal tool calls require no external bearer/OAuth token.
- [x] all active MCP tools advertise `securitySchemes: [{type: 'noauth'}]`.
- [x] external OAuth/static bearer dispatch/fallback logic is removed from active MCP request handling.
- [x] Host/Origin checks remain enabled.
- [x] request body size limit remains enabled.
- [x] request deadline remains enabled.
- [x] rate limit remains enabled.
- [x] structured logging remains secret-safe.
- [x] `BRIGHT_INTEGRATION_TOKEN` remains required for MCP -> app with minimum 16-character length.
- [x] missing/wrong backend service token fails with zero durable mutation.
- [x] `MCP_NOAUTH_WRITE_ENABLED=false` is the default.
- [x] disabled write/cost-bearing tools fail with `NOAUTH_WRITE_DISABLED` before backend side effects.
- [x] `MCP_MAX_INFLIGHT_WRITE_REQUESTS` is finite; default `2`.
- [x] `BRIGHT_CHATGPT_MAX_ACTIVE_PROJECTS` is finite; default `3`.
- [x] `MCP_RATE_LIMIT_PER_MINUTE` is finite; default `20`.
- [x] MCP-local active-project checks are optimization only, durable backend invariant is authoritative.

**Verification:**

- [x] focused noauth transport tests RED -> GREEN;
- [x] kill-switch zero-mutation regressions;
- [x] rate/in-flight capacity regressions;
- [x] direct backend service-auth negative tests;
- [x] existing body/deadline/rate-limit/Host/Origin regressions green.

---

## T18 — Simplify handoff/approval schema for noauth mode

**Status:** COMPLETED & CI-VERIFIED

- [x] `approve_video_project` public MCP input no longer exposes caller-selectable `mode`.
- [x] public MCP input no longer exposes caller-selectable `approvalActor`.
- [x] public MCP input no longer exposes `delegationGrant`.
- [x] public MCP input no longer exposes `delegatedContext`.
- [x] MCP/integration semantics call the result `external_review_acknowledged`.
- [x] audit actor/origin is a bounded integration-origin value such as `chatgpt_mcp_noauth`, not a claimed authenticated human identity.
- [x] if backend schema still persists `approval_mode='user_reviewed'`, the mapping to external review acknowledgment is explicit.
- [x] responses/logs/tests/docs do not call the legacy storage value authenticated human-review proof.
- [x] revision ID + expected payload hash remain required.
- [x] current draft/source/schema legality checks remain authoritative.

**Verification:**

- [x] schema rejects removed/deferred fields;
- [x] stale revision/hash regression green;
- [x] valid external review acknowledgment regression green;
- [x] no assertion equates legacy `user_reviewed` with authenticated human identity/review.

---

## T19 — Retain durable ChatGPT handoff storage

**Status:** COMPLETED & CI-VERIFIED

- [x] schema v3 stores `origin=chatgpt_mcp`.
- [x] schema v3 stores integration idempotency key.
- [x] schema v3 stores approval mode/actor/context fields.
- [x] migration/reopen coverage exists.
- [x] no new destructive migration is introduced merely to remove deferred OAuth/delegation behavior or rename the compatibility approval enum.
- [x] active runtime no longer depends on persisted OAuth client/session/token state.
- [x] legacy `user_reviewed` compatibility semantics are documented if retained.
- [x] storage/repository API can enforce active-project admission in one SQLite transaction with create/reactivation.
- [x] exact-head migration/reopen checks pass after reset.

---

## T20 — Retain service-authenticated EvidenceBundle import + transactional capacity admission

**Status:** COMPLETED & CI-VERIFIED

- [x] backend revalidates imported EvidenceBundle.
- [x] imported project persists application-owned evidence/source provenance.
- [x] imported origin is `chatgpt_mcp`.
- [x] same idempotency key maps to the same project.
- [x] imported project skips backend research provider.
- [x] supplied complete draft is validated/remapped and persisted directly at `review_required` without a generation job.
- [x] omitted-draft compatibility import reaches `research_ready` and queues generation; this is not the T28 supported path.
- [x] direct calls without valid `BRIGHT_INTEGRATION_TOKEN` fail closed with zero mutation after noauth reset.
- [x] idempotent replay returns the existing project without consuming another active slot.
- [x] for a genuinely new project, active-project count check + project creation + first active work enqueue happen in the same SQLite transaction.
- [x] new create is rejected with `NOAUTH_CAPACITY_REACHED` when the configured non-terminal ChatGPT-origin cap is full.
- [x] capacity rejection commits no new project/job.
- [x] two concurrent creates competing for the final slot cannot both commit.
- [x] exact-head import/reopen/idempotency regressions remain green.

---

## T21 — Convert MCP tools to noauth transport

**Status:** COMPLETED & CI-VERIFIED

- [x] `normalize_evidence` uses `noauth` security metadata.
- [x] `create_video_project` uses `noauth` security metadata.
- [x] `get_video_project` uses `noauth` security metadata.
- [x] `edit_video_draft` uses `noauth` security metadata.
- [x] `approve_video_project` uses `noauth` security metadata.
- [x] `start_video_render` uses `noauth` security metadata.
- [x] `retry_video_project` uses `noauth` security metadata.
- [x] `cancel_video_project` uses `noauth` security metadata.
- [x] OAuth scope checks are removed from active MCP handlers.
- [x] synthetic authenticated-user context is removed.
- [x] MCP -> backend correlation IDs remain propagated.
- [x] backend client remains private/service-authenticated.
- [x] all mutating tools pass through write-enable + in-flight capacity gate before backend dispatch.
- [x] authoritative active-project admission is delegated to Bright Profile durable storage boundary.

### Checkpoint A

- [x] no Authorization -> initialize succeeds;
- [x] no Authorization -> tools/list succeeds;
- [x] writes disabled -> write tool fails with zero mutation;
- [x] writes enabled -> legal write tool reaches backend;
- [x] direct backend no token/wrong token -> reject;
- [x] Host/body/deadline/rate-limit controls remain green.

---

## T22 — Review/edit/external-review-acknowledgment path

**Status:** COMPLETED & CI-VERIFIED

- [x] project status can expose current draft/revision/hash.
- [x] draft edits are revision/hash fenced.
- [x] backend approval path exists.
- [x] supplied-draft flow is explicitly documented/tested to stop at `review_required` without backend generation.
- [x] backend itself never auto-approves or starts downstream work at `review_required`.
- [ ] live ChatGPT Path A proves the tested client does not invoke approval/render before user confirmation.
- [x] `approve_video_project` records external review acknowledgment semantics.
- [x] caller cannot select actor/mode/delegation state.
- [x] stale/illegal approval remains fail-closed.
- [x] downstream-started edit lock remains authoritative.
- [x] no audit/log/API claim says the noauth backend authenticated the human reviewer.

---

## T23 — Defer delegated E2E authorization

**Status:** COMPLETED & CI-VERIFIED

- [x] remove `delegated_e2e` from active MCP input contract.
- [x] remove/deactivate delegation grant issuance from current supported flow.
- [x] remove/deactivate delegation grant verification from current supported flow.
- [x] remove loopback `/api/projects/:id/delegation-grant` if no retained supported caller exists.
- [x] remove `delegationGrant`/`delegatedContext` active runtime handling.
- [x] remove delegated positive-path E2E/tests from current milestone.
- [x] remove stale docs/status/PR claims that delegated E2E is implemented/verified.
- [x] keep DB approval columns if removing them would create unnecessary migration churn.

### Checkpoint B

- [x] model/tool input cannot create trusted user identity;
- [x] model/tool input cannot choose delegated approval;
- [x] backend stops at `review_required`;
- [x] valid external review acknowledgment works when writes are enabled;
- [x] no server claim equates acknowledgment with authenticated human proof.

---

## T24 — Render/retry/cancel controls + capacity-aware retry

**Status:** COMPLETED & CI-VERIFIED

- [x] render-start wrapper exists.
- [x] duplicate active render-start is idempotent.
- [x] retry wraps durable backend retry semantics.
- [x] cancel wraps durable backend cancellation/fencing semantics.
- [x] no external-auth assumption remains in these MCP wrappers.
- [x] write kill-switch applies before render/retry/cancel backend mutation.
- [x] in-flight write cap applies to mutating wrappers.
- [x] retry/requeue that changes a failed/inactive ChatGPT-origin project back to active uses the same durable active-project admission transaction as create.
- [x] retry at full capacity returns `NOAUTH_CAPACITY_REACHED` with zero replacement attempt/job/state mutation.
- [x] repeated retry for already queued/running replacement work remains idempotent and consumes no second slot.
- [x] cancel/stale-owner fencing remains authoritative.
- [x] exact-head render/retry/cancel regressions remain green.

---

## T25 — Signed authoritative MP4 delivery

**Status:** COMPLETED & CI-VERIFIED

- [x] signed download token binds project/revision/artifact.
- [x] expiration/tamper checks exist.
- [x] authoritative output metadata/file integrity is checked.
- [x] public MCP proxy requires signed capability token.
- [x] proxy streams output rather than buffering full MP4.
- [x] timeout/backpressure controls exist.
- [x] no OAuth/static external bearer dependency remains in completed-output delivery.
- [x] exact-head valid/wrong-project/wrong-revision/wrong-artifact/expired/tampered tests pass.

---

## T26 — Remove OAuth/DCR deployment/config/runtime state and define bounded noauth ingress

**Status:** COMPLETED & CI-VERIFIED

Remove from active runtime/config:

- [x] `MCP_AUTH_TOKEN`.
- [x] `MCP_OAUTH_SECRET`.
- [x] `BRIGHT_USER_AUTH_SECRET`.
- [x] `MCP_CLIENT_STORAGE_PATH`.
- [x] OAuth client-storage named volume.
- [x] OAuth/DCR/session routes and discovery metadata.
- [x] `security/oauth.mjs`.
- [x] OAuth-specific integration tests.

Keep/add/verify:

- [x] `MCP_PUBLIC_URL`.
- [x] `MCP_ALLOWED_HOSTS`.
- [x] `MCP_MAX_BODY_BYTES`.
- [x] `MCP_REQUEST_TIMEOUT_MS`.
- [x] `BRIGHT_BACKEND_URL`.
- [x] `BRIGHT_INTEGRATION_TOKEN`.
- [x] `MCP_NOAUTH_WRITE_ENABLED=false`.
- [x] `MCP_RATE_LIMIT_PER_MINUTE=20` default or stricter finite value.
- [x] `MCP_MAX_INFLIGHT_WRITE_REQUESTS=2` default or stricter finite value.
- [x] `BRIGHT_CHATGPT_MAX_ACTIVE_PROJECTS=3` default or stricter finite value.
- [x] MCP has no Bright SQLite/artifact mount.
- [x] worker publishes no port.
- [x] standalone app remains private/loopback-oriented.
- [x] remote ChatGPT access is through intended HTTPS MCP ingress/reverse proxy only.
- [x] private MCP -> app network path works.
- [x] request correlation remains secret-safe.
- [x] no noauth limit defaults to unlimited.
- [x] no process-local counter is treated as authoritative for active capacity cap.
- [ ] T28 closure requires external MCP ingress withdrawal even after writes are disabled.

---

## T27 — Deterministic noauth full E2E + adversarial regression

**Status:** COMPLETED & CI-VERIFIED

Required supported T28 contract coverage:

- [x] start app + MCP.
- [x] initialize MCP without Authorization.
- [x] prove writes are disabled by default.
- [x] start test instance/config with writes explicitly enabled.
- [x] `normalize_evidence`.
- [x] construct a complete structured draft whose `sourceIds` use normalized evidence IDs.
- [x] `create_video_project` receives both `evidenceBundle` and `draft`.
- [x] supplied-draft import creates no generation job.
- [x] `get_video_project` reaches `review_required`.
- [x] prove zero backend auto-approval before explicit tool invocation.
- [x] prove zero downstream media/render before explicit approval/render tool calls.

Retained compatibility/lifecycle E2E coverage:

- [x] omitted-draft `create_video_project` queues generation.
- [x] compatibility generation completes and reaches `review_required`.
- [x] test harness invokes `approve_video_project`.
- [x] external review acknowledgment is recorded; any legacy `user_reviewed` storage value is treated only as compatibility representation.
- [x] `start_video_render`.
- [x] media ingest completes.
- [x] TTS completes.
- [x] render completes.
- [x] project reaches `completed`.
- [x] signed MP4 downloads and validates.

Required adversarial/recovery coverage:

- [x] write kill-switch returns `NOAUTH_WRITE_DISABLED` with zero mutation;
- [x] configured rate limit is enforced;
- [x] configured in-flight write cap is enforced;
- [x] new create at active cap returns `NOAUTH_CAPACITY_REACHED` with no project/job mutation;
- [x] retry/reactivation at active cap returns `NOAUTH_CAPACITY_REACHED` with no replacement attempt/job/state mutation;
- [x] concurrent create + retry (or equivalent two independent admissions) at the final slot proves at most one commits and active count never exceeds the cap;
- [x] idempotent create/retry replay does not consume duplicate slots;
- [x] duplicate render/retry calls do not duplicate durable work;
- [x] DB reopen/restart retains representative state;
- [x] stale edit/approval rejected;
- [x] direct backend no/wrong service token rejected with zero mutation;
- [x] retry/cancel/stale-owner fencing retained;
- [x] signed-download expired/tampered/wrong-binding cases fail closed;
- [x] prompt-injection-looking source text remains inert data;
- [x] old OAuth/delegated setup is absent from the E2E harness;
- [x] deterministic test does not claim it proves real human review.

Verification:

- [x] focused E2E test green;
- [x] `npm test` green;
- [x] `npm run lint` green;
- [x] `npm run audit:standalone` green;
- [x] `npm run build:web` green;
- [x] `npm run render:smoke` green;
- [x] standalone Compose boundary green;
- [x] MCP Compose boundary green.

---

## T28 — Live ChatGPT noauth acceptance and documentation closure

**Status:** OPEN — LIVE ACCEPTANCE REQUIRED

### Acceptance-window setup

- [ ] deploy exact implementation HEAD/image.
- [ ] remote MCP ingress is intentionally enabled for the bounded acceptance window.
- [ ] `MCP_NOAUTH_WRITE_ENABLED=true` is set explicitly for the window.
- [ ] configured rate/in-flight/active-project limits are recorded.
- [ ] ingress enable timestamp is recorded.
- [ ] standalone app itself remains private.

### Live Path A — stop at review

- [ ] connect ChatGPT without OAuth linking/auth setup.
- [ ] actual `normalize_evidence` tool call occurs.
- [ ] ChatGPT constructs a complete structured draft using normalized evidence IDs.
- [ ] actual `create_video_project` call contains both `evidenceBundle` and `draft`.
- [ ] no backend generation stage/provider call is used.
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

### Acceptance-window teardown — both required

- [ ] `MCP_NOAUTH_WRITE_ENABLED=false` is restored.
- [ ] external HTTPS MCP ingress/reverse-proxy route is withdrawn/disabled.
- [ ] remote MCP endpoint is verified no longer externally reachable.
- [ ] write-disable timestamp is recorded.
- [ ] ingress-withdraw timestamp is recorded.
- [ ] if later temporary testing is needed, a new explicitly approved bounded window is opened rather than leaving T28 ingress running.

### Evidence/closure

- [ ] record exact HEAD/image/environment.
- [ ] record project IDs/status transitions/tool calls without secrets.
- [ ] record bounded approval provenance without claiming authenticated human identity.
- [ ] record configured noauth limits and ingress/write-window enable/disable times.
- [ ] record completed download/playback evidence.
- [ ] full exact-head `Bright Profile Verification` workflow green.
- [ ] project-wide Definition of Done checked.
- [ ] `docs/project-status.md` updated from observed truth.
- [ ] `tasks/traceability.md` closure audit updated from observed truth.
- [ ] PR body updated to report actual test counts and truthful noauth approval semantics.

---

## Final Definition of Done for This Reset

Do not mark the milestone complete until all are true:

- [ ] external ChatGPT -> MCP is one coherent `noauth` contract used only during a bounded ingress window;
- [ ] OAuth/DCR/session/static external bearer code/config is absent from the active milestone;
- [ ] private MCP -> Bright Profile service authentication remains fail-closed;
- [ ] anonymous writes are disabled by default;
- [ ] rate/in-flight caps are finite and enforced;
- [ ] active-project capacity is enforced transactionally for create and retry/reactivation;
- [ ] concurrent admissions cannot exceed the configured active-project cap;
- [ ] `delegated_e2e` is deferred and unreachable from the active MCP contract;
- [ ] approval is represented as external review acknowledgment, not authenticated human proof;
- [ ] deterministic noauth E2E passes without claiming human-review proof;
- [ ] exact-head CI passes;
- [ ] live ChatGPT noauth Path A and Path B pass;
- [ ] after live acceptance, writes are disabled **and** external MCP ingress is withdrawn;
- [ ] docs and PR body describe only observed current truth.
