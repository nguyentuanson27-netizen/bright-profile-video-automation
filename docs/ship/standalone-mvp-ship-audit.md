# Ship Audit: Standalone Bright Profile Internal MVP

**Audit updated:** 2026-08-15  
**Target source branch:** `spec/standalone-production-app`  
**Target destination:** `main`  
**Promotion PR:** #13  
**Current decision:** **HOLD / NO-GO for merge until fresh exact-head CI and explicit human approval are satisfied.**

## Scope

This audit governs repository promotion of the frozen **internal standalone MVP** into the default branch. It is not a public/commercial production launch and does not authorize broader network exposure or deployment to an external environment.

Retained flow:

`create -> research -> generate -> review/edit -> approve -> render-start -> media ingest -> TTS -> render -> download`

## Current release state

The release has advanced beyond the original closure audit:

- T01–T16 implementation is complete on `spec/standalone-production-app`;
- PR #12 (`ship: close standalone MVP release gates`) merged into the source branch as commit `5594bc16d9ce30c5155a0f5ec4bb261bdaf431cf`;
- PR #12 exact-head workflow `31806106643` completed **SUCCESS**;
- source-branch push workflow `31825258653` on merge commit `5594bc16d9ce30c5155a0f5ec4bb261bdaf431cf` completed **SUCCESS**;
- promotion PR #13 is open from `spec/standalone-production-app` to `main`;
- promotion workflow `31826285093`, attempt 2, completed **SUCCESS** on exact head `07a079a6bb5ae44e66c15a8b248cde0e6e2a6868`;
- the repository owner explicitly accepted the residual browser/UI risk and authorized a **one-time real-browser smoke waiver for PR #13** in PR comment `5297075013`;
- release-state documentation is being synchronized to that owner decision on the promotion branch;
- `main` has not yet received the standalone MVP.

At promotion open, `main` was `54d7ce5bd4d72b376e923a2969297762e261b4fe`, and the source branch was ahead with no divergence from `main`.

## Verified evidence

### Implementation verification

PR #11 exact-head run `31799285582` completed **SUCCESS** and covered the integrated T14–T16 closure together with the retained earlier implementation.

### Release-closure verification

PR #12 exact-head run `31806106643` and post-merge source-branch push run `31825258653` both completed **SUCCESS**.

### Promotion verification before waiver-doc sync

PR #13 workflow `31826285093`, attempt 2, completed **SUCCESS** on exact head `07a079a6bb5ae44e66c15a8b248cde0e6e2a6868`. The initial attempt had a Chrome-connect timeout at the render smoke after earlier gates had passed; the same-head rerun passed the complete workflow, so no runtime change was made for that transient failure.

The full verification gate covers:

- frozen `npm ci` install;
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

Because the owner-waiver documentation changes the promotion head, `31826285093` becomes supporting evidence only. The final documentation-sync head requires a fresh full workflow before merge.

## Closure findings and resolution

### Promotion CI trigger gap — resolved

The workflow previously verified PRs only when targeting `spec/standalone-production-app`. PR #12 extended it to PRs targeting `main` and pushes to `main`, while retaining source/build gates.

PR #12 and its source-branch post-merge push both passed after that change.

### Current-state documentation drift — resolved for promotion phase

The promotion documentation records PR #12 merged, closure/post-merge source CI green, PR #13 open, `main` not yet promoted, and the remaining promotion gates.

### Rollback plan — retained

Repository and optional persistent-host rollback procedures remain defined below.

### Real browser accessibility/interaction walkthrough — one-time waived for PR #13, not verified

Automated UI state/control regressions, semantic controls, Vite production build, and built-web health checks exist. A real interactive browser walkthrough for the complete supported operator flow and keyboard/focus behavior has **not** been recorded.

The repository owner explicitly accepted this residual browser/UI risk for the internal MVP promotion and authorized treating it as a **documented one-time waiver for PR #13**. This is **not** a passing browser result and must never be represented as one.

The waived verification remains a follow-up item: when browser tooling is available, exercise the built UI for create/status/review/edit/approve/render/download plus legal retry/cancel, confirm no new console errors, and check keyboard reachability/focus for interactive controls. Any defect found returns through the normal debug -> test -> review flow.

This waiver does not lower the standing browser/accessibility quality gate for future releases.

## Definition of Done audit

### Correctness

- **Verified:** T01–T16 behavior has focused unit/integration regressions and deterministic standalone E2E evidence.
- **Verified:** retry/cancel/reclaim/heartbeat/approval-race and output integrity paths are covered by closure evidence.
- **Pending after waiver-doc sync:** fresh full CI on the final exact PR #13 head.

### Quality

- **Verified:** aggregate lint and syntax gates passed on implementation and prior promotion evidence.
- **Verified:** no runtime/provider/storage/schema/Compose feature delta is introduced by the waiver documentation sync.
- **Pending:** final promotion-head review/approval after documentation synchronization.

### Integration

- **Verified:** standalone app/worker Compose topology, SQLite migrations, shared volume, health endpoints, Remotion smoke and MCP regression boundary passed CI.
- **Pending:** PR #13 exact-head merge-result verification against `main`.
- **Pending after merge:** `main` push verification.

### Documentation

- **Verified/being synchronized on promotion head:** `docs/project-status.md` and this ship audit record the owner waiver truthfully as not-verified residual risk.
- `tasks/traceability.md` remains the frozen requirement/implementation/verification ledger and does not need release-state mutation.
- `tasks/plan.md`, `tasks/todo.md`, and the historical production spec are lower-precedence planning/history artifacts; current truth is governed by the authoritative documents above.

### Security

- **Verified:** standalone and MCP dependency audits passed on release-closure and prior promotion evidence.
- **Verified contract:** SSRF-safe fetch, model-output distrust, artifact path/ownership, non-root containers, loopback app publish, non-published worker and read-only worker credential mount remain required gates.
- **No scope expansion:** promotion does not broaden auth, network, provider, data, or filesystem permissions.

### Observability / operations

For this internal private/loopback milestone, health endpoints, persisted stage/error state, request IDs, and deterministic recovery are the retained operational contract. Full public-production SLO/metrics infrastructure remains out of scope.

If the app is intentionally exposed beyond the trusted internal boundary, a separate auth/TLS/observability ship task is required first.

### Accessibility

- **Automated/static evidence:** UI state/control tests and production build exist.
- **Not verified in a real browser for PR #13:** keyboard/focus/console walkthrough.
- **Owner decision:** one-time waiver accepted for this internal MVP promotion; follow-up remains required and future release quality bars are unchanged.

## CI / promotion policy

Current sequence:

1. **done** — merge PR #12 release closure after full CI;
2. **done** — verify post-merge push on `spec/standalone-production-app`;
3. **done** — open promotion PR #13 `spec/standalone-production-app -> main`;
4. **done** — synchronize authoritative docs to the promotion phase;
5. **done on prior head** — full `Bright Profile Verification` passed on `07a079a6bb5ae44e66c15a8b248cde0e6e2a6868` via run `31826285093`, attempt 2;
6. **waived for PR #13 only** — real-browser keyboard/focus/console smoke; explicitly not verified and retained as follow-up;
7. **required after waiver-doc sync** — full `Bright Profile Verification` passes on the final exact PR #13 head;
8. **required** — human explicitly approves the final promotion head;
9. **required** — merge PR #13 to `main` using an exact-head guard;
10. **required** — `main` push verification completes successfully.

No feature work should be added to PR #13. Any runtime/code change after the final release review reopens the applicable verification/review gates.

## Rollback plan

### Repository integration rollback

Merging PR #13 to `main` is repository integration only; no deployment workflow exists in `.github/workflows` for this milestone.

Before promotion merge, record:

- pre-merge `main` SHA;
- final PR #13 exact head SHA;
- merge method used;
- resulting merge commit SHA.

If the default-branch promotion must be rolled back:

1. do not force-push shared `main`;
2. create a revert PR that reverses the promotion merge commit;
3. run the same full verification workflow on the revert PR;
4. merge the revert only after green CI and human review;
5. verify the post-revert `main` push workflow.

### Runtime deployment rollback

No runtime deployment is performed by this repository promotion.

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

### Current verdict: HOLD / NO-GO for merge

The implementation, release-closure, source-branch, and prior exact-head promotion gates are green. The browser walkthrough is explicitly waived—not passed—for this one internal MVP promotion. The final documentation-sync head still requires fresh full CI and explicit human approval before merge.

### Gate status

- [x] release-closure PR #12 full workflow green on exact head;
- [x] release-closure decision explicitly authorized by the human release owner;
- [x] release-closure PR #12 merged into `spec/standalone-production-app`;
- [x] source-branch post-merge workflow `31825258653` green;
- [x] promotion PR #13 `spec/standalone-production-app -> main` opened;
- [x] prior promotion head `07a079a6bb5ae44e66c15a8b248cde0e6e2a6868` full workflow `31826285093` attempt 2 green;
- [x] owner explicitly accepted a one-time PR #13 waiver for missing real-browser keyboard/focus/console smoke; browser evidence remains **not verified**;
- [ ] final waiver-documentation exact-head PR #13 full workflow green;
- [ ] human explicitly approves the final PR #13 head;
- [ ] PR #13 merged to `main`;
- [ ] post-merge `main` push workflow green;
- [ ] follow-up real-browser keyboard/focus/console verification closed with actual evidence;
- [ ] rollback owner recorded if a persistent host deployment will follow.

Only after the applicable promotion gates pass should repository promotion be called **SHIP-ready / complete**. The browser follow-up may remain open after repository promotion because its residual risk was explicitly accepted for PR #13, but it must stay visible until actual evidence closes it.
