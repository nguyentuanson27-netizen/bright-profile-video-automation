# Ship Audit: Standalone Bright Profile Internal MVP

**Audit updated:** 2026-08-15  
**Promoted source:** `spec/standalone-production-app`  
**Destination:** `main`  
**Promotion PR:** #13  
**Current decision:** **GO / repository promotion complete.** Real-browser keyboard/focus/console verification remains an explicitly waived, still-open follow-up.

## Scope

This audit governs repository promotion of the frozen **internal standalone MVP** into the default branch. It is not a public/commercial production launch and does not authorize broader network exposure or deployment to an external environment.

Retained flow:

`create -> research -> generate -> review/edit -> approve -> render-start -> media ingest -> TTS -> render -> download`

## Promotion result

The repository promotion is complete:

- T01–T16 implementation completed on `spec/standalone-production-app`;
- PR #12 (`ship: close standalone MVP release gates`) merged into the source branch as `5594bc16d9ce30c5155a0f5ec4bb261bdaf431cf`;
- PR #12 exact-head workflow `31806106643`: **SUCCESS**;
- source-branch post-merge workflow `31825258653`: **SUCCESS**;
- PR #13 promoted `spec/standalone-production-app` to `main`;
- pre-promotion `main`: `54d7ce5bd4d72b376e923a2969297762e261b4fe`;
- final PR #13 head: `b4fa4d73dd258eefe336420cbf9d09e5743980a1`;
- resulting `main` merge commit: `4f8344de2dbd9963a5d4b3a96e6aeeb19d36e098`;
- post-merge `main` push workflow `31837273738`: **SUCCESS** on that exact merge commit.

No runtime deployment is performed by this repository promotion.

## Browser-smoke waiver truth

A real interactive browser walkthrough for the complete supported operator flow, console behavior, and keyboard/focus behavior was **not run** for PR #13.

The repository owner explicitly accepted this residual browser/UI risk and authorized a **one-time real-browser smoke waiver for PR #13** in PR conversation comment `5297075013`.

This means:

- browser smoke is **waived for this completed promotion only**;
- it is **not verified** and must never be represented as a passing browser result;
- the waived verification remains a follow-up item;
- future releases keep the standing browser/accessibility quality gate unless the owner explicitly makes a new decision.

When browser tooling is available, exercise create/status/review/edit/approve/render/download plus legal retry/cancel, confirm no new console errors, and check keyboard reachability/focus for interactive controls. Any defect found returns through the normal debug -> test -> review flow.

## Verification evidence

### Implementation closure

PR #11 exact-head run `31799285582` completed **SUCCESS** and covered the integrated T14–T16 closure together with the retained earlier implementation.

### Release closure

PR #12 exact-head run `31806106643` and post-merge source-branch push run `31825258653` both completed **SUCCESS**.

### Promotion verification

Promotion verification included fresh exact-head CI before merge and a fresh push workflow after merge. The post-merge workflow `31837273738` completed **SUCCESS** on `main` merge commit `4f8344de2dbd9963a5d4b3a96e6aeeb19d36e098`.

The full verification gate covers:

- frozen dependency install;
- standalone production dependency audit;
- separate MCP production dependency audit;
- pinned `better-sqlite3` rebuild;
- SQLite migration smoke;
- full unit/integration suite;
- aggregate first-party lint;
- Vite production build;
- syntax checks;
- standalone API + built UI liveness/readiness;
- MCP process health;
- Remotion render smoke;
- standalone Compose boundary validation;
- real standalone app + worker image build/runtime checks;
- app non-root + loopback-only host publishing;
- worker non-root + no published port + no inherited HTTP healthcheck;
- read-only Google ADC credential mount into worker only;
- retained MCP Compose and isolated MCP container checks;
- teardown.

An earlier promotion attempt had a Chrome-connect timeout at render smoke after earlier gates had passed. A same-head rerun passed the complete workflow, so no runtime change was made for that transient failure.

## Definition of Done audit

### Correctness

- **Verified:** T01–T16 behavior has focused unit/integration regressions and deterministic standalone E2E evidence.
- **Verified:** retry/cancel/reclaim/heartbeat/approval-race and output integrity paths are covered by closure evidence.
- **Verified:** final repository promotion received fresh exact-head verification and post-merge `main` verification.

### Quality

- **Verified:** aggregate lint, build, syntax, render and container gates passed.
- **Verified:** promotion did not introduce an unreviewed runtime/provider/storage/schema/Compose delta after release closure.

### Integration

- **Verified:** standalone app/worker Compose topology, SQLite migrations, shared volume, health endpoints, Remotion smoke and MCP regression boundary passed CI.
- **Verified:** PR #13 merged to `main` and `main` push verification succeeded.

### Documentation

- `docs/project-status.md` is the highest-precedence current-state document.
- `docs/specs/standalone-internal-mvp-amendment.md` remains the active functional contract; its release checklist must be read together with the newer project-status/ship closure state if a historical pre-merge line remains.
- `tasks/traceability.md` remains the frozen requirement/implementation/verification ledger.
- `tasks/plan.md`, `tasks/todo.md`, and the historical production spec remain lower-precedence planning/history artifacts where their old checkbox/status prose conflicts with current closure truth.

### Security

- **Verified:** standalone and MCP dependency audits passed in the release/promotion verification path.
- **Retained contract:** SSRF-safe fetch, model-output distrust, artifact path/ownership, non-root containers, loopback app publish, non-published worker and read-only worker credential mount remain required boundaries.
- **No scope expansion:** repository promotion does not broaden auth, network, provider, data, or filesystem permissions.

### Observability / operations

For this internal private/loopback milestone, health endpoints, persisted stage/error state, request IDs, and deterministic recovery are the retained operational contract. Full public-production SLO/metrics infrastructure remains out of scope.

If the app is intentionally exposed beyond the trusted internal boundary, a separate auth/TLS/observability ship task is required first.

### Accessibility

- **Automated/static evidence:** UI state/control tests and production build exist.
- **Not verified in a real browser for PR #13:** keyboard/focus/console walkthrough.
- **Owner decision:** one-time waiver accepted for the completed internal MVP promotion; follow-up remains required and future release quality bars are unchanged.

## Promotion sequence — final state

1. **done** — merge PR #12 release closure after full CI;
2. **done** — verify post-merge push on `spec/standalone-production-app`;
3. **done** — open promotion PR #13 `spec/standalone-production-app -> main`;
4. **done** — synchronize authoritative promotion docs;
5. **done** — promotion exact-head verification green before merge;
6. **waived for PR #13 only** — real-browser keyboard/focus/console smoke; explicitly not verified and retained as follow-up;
7. **done** — human release decision/approval satisfied for promotion;
8. **done** — merge PR #13 to `main` using exact-head protection;
9. **done** — `main` push workflow `31837273738` completed **SUCCESS**.

Repository promotion is now closed. No feature work should be retroactively added to PR #13; future changes use new short-lived branches/PRs and re-enter the applicable verification/review gates.

## Rollback plan

### Repository integration rollback

The promoted `main` merge commit is `4f8344de2dbd9963a5d4b3a96e6aeeb19d36e098`.

If the default-branch promotion must be rolled back:

1. do not force-push shared `main`;
2. create a revert PR that reverses the promotion merge commit;
3. run the same full verification workflow on the revert PR;
4. merge the revert only after green CI and human review;
5. verify the post-revert `main` push workflow.

### Runtime deployment rollback

No runtime deployment was performed by repository promotion.

If a persistent internal host is later updated:

1. record the currently deployed commit/image before changing it;
2. stop application writers and take a consistent backup/snapshot of the `bright-data` volume, including `bright-profile.sqlite` and authoritative artifacts;
3. deploy the new image/commit;
4. verify `/health/live`, `/health/ready`, UI load, and one representative critical flow before declaring the host healthy;
5. roll back on data-integrity/security failure, repeated new error class, broken health/readiness, or inability to produce/download an authoritative MP4;
6. redeploy the previously recorded image/commit;
7. if the older code cannot safely operate on the migrated SQLite state, restore the pre-deploy data snapshot instead of attempting an unproven destructive down migration.

Current migrations are additive, but this audit does **not** claim a tested automatic database down-migration path.

## GO / NO-GO gate

### Current verdict: GO — repository promotion complete

The implementation, release-closure, promotion exact-head, merge, and post-merge `main` verification gates are green. The browser walkthrough is explicitly waived—not passed—for this one internal MVP promotion and remains the sole open verification follow-up.

### Gate status

- [x] release-closure PR #12 full workflow green on exact head;
- [x] release-closure decision explicitly authorized by the human release owner;
- [x] release-closure PR #12 merged into `spec/standalone-production-app`;
- [x] source-branch post-merge workflow `31825258653` green;
- [x] promotion PR #13 opened;
- [x] final promotion exact-head verification green;
- [x] owner explicitly accepted a one-time PR #13 waiver for missing real-browser keyboard/focus/console smoke; browser evidence remains **not verified**;
- [x] human release approval/decision satisfied for promotion;
- [x] PR #13 merged to `main`;
- [x] post-merge `main` push workflow `31837273738` green on `4f8344de2dbd9963a5d4b3a96e6aeeb19d36e098`;
- [ ] follow-up real-browser keyboard/focus/console verification closed with actual evidence;
- [ ] rollback owner recorded if a persistent host deployment is performed later.

Repository promotion may be called **SHIP-ready / complete**. The browser follow-up remains open because its residual risk was explicitly accepted for PR #13, not because it was verified.
