# Ship Audit: Standalone Bright Profile Internal MVP

**Audit updated:** 2026-08-15  
**Target source branch:** `spec/standalone-production-app`  
**Target destination:** `main`  
**Promotion PR:** #13  
**Current decision:** **HOLD / NO-GO for merge until the remaining promotion gates below are satisfied.**

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
- release-state documentation is being synchronized on the promotion head itself;
- `main` has not yet received the standalone MVP.

At promotion open, `main` was `54d7ce5bd4d72b376e923a2969297762e261b4fe`, and the source branch was ahead with no divergence from `main`.

## Verified evidence

### Implementation verification

PR #11 exact-head run `31799285582` completed **SUCCESS** and covered the integrated T14–T16 closure together with the retained earlier implementation.

### Release-closure verification

PR #12 exact-head run `31806106643` and post-merge source-branch push run `31825258653` both completed **SUCCESS**.

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

Historical green runs are supporting evidence. PR #13 still requires the same workflow on its **final exact head**, including all documentation-sync commits.

## Closure findings and resolution

### Promotion CI trigger gap — resolved

The workflow previously verified PRs only when targeting `spec/standalone-production-app`. PR #12 extended it to PRs targeting `main` and pushes to `main`, while retaining source/build gates.

PR #12 and its source-branch post-merge push both passed after that change.

### Current-state documentation drift — resolved for promotion head

The previous docs still described PR #12 as pending after it had merged.

The promotion head now records:

- PR #12 merged;
- closure and post-merge source CI green;
- promotion PR #13 open;
- `main` not yet promoted;
- remaining exact-head/browser/human/main-push gates.

### Rollback plan — retained

Repository and optional persistent-host rollback procedures remain defined below.

### Real browser accessibility/interaction walkthrough — pending

Automated UI state/control regressions, semantic controls, Vite production build, and built-web health checks exist. A real interactive browser walkthrough for the complete supported operator flow and keyboard/focus behavior has not been recorded in this audit.

**Required before final GO unless explicitly resolved by the human release owner:** exercise the built UI for create/status/review/edit/approve/render/download plus legal retry/cancel, confirm no new console errors, and check keyboard reachability/focus for interactive controls. Record the outcome on PR #13.

## Definition of Done audit

### Correctness

- **Verified:** T01–T16 behavior has focused unit/integration regressions and deterministic standalone E2E evidence.
- **Verified:** retry/cancel/reclaim/heartbeat/approval-race and output integrity paths are covered by closure evidence.
- **Pending:** fresh full CI on the final exact PR #13 head.

### Quality

- **Verified:** aggregate lint and syntax gates passed on implementation and release-closure evidence.
- **Verified:** PR #12 closure delta was limited to CI/docs/ship state; no runtime feature was added there.
- **Pending:** final promotion-head review after documentation synchronization.

### Integration

- **Verified:** standalone app/worker Compose topology, SQLite migrations, shared volume, health endpoints, Remotion smoke and MCP regression boundary passed CI.
- **Pending:** PR #13 exact-head merge-result verification against `main`.
- **Pending after merge:** `main` push verification.

### Documentation

- **Verified on promotion head:** `docs/project-status.md`, the active internal-MVP spec, and this ship audit have been updated to current release state.
- `tasks/traceability.md` remains the frozen requirement/implementation/verification ledger and does not need release-state mutation.
- `tasks/plan.md`, `tasks/todo.md`, and the historical production spec are lower-precedence planning/history artifacts; current truth is governed by the authoritative documents above.

### Security

- **Verified:** standalone and MCP dependency audits passed on release-closure evidence.
- **Verified contract:** SSRF-safe fetch, model-output distrust, artifact path/ownership, non-root containers, loopback app publish, non-published worker and read-only worker credential mount remain required gates.
- **No scope expansion:** promotion does not broaden auth, network, provider, data, or filesystem permissions.

### Observability / operations

For this internal private/loopback milestone, health endpoints, persisted stage/error state, request IDs, and deterministic recovery are the retained operational contract. Full public-production SLO/metrics infrastructure remains out of scope.

If the app is intentionally exposed beyond the trusted internal boundary, a separate auth/TLS/observability ship task is required first.

### Accessibility

- **Automated/static evidence:** UI state/control tests and production build exist.
- **Pending:** real browser keyboard/focus/console walkthrough or explicit release-owner resolution.

## CI / promotion policy

Current sequence:

1. **done** — merge PR #12 release closure after full CI;
2. **done** — verify post-merge push on `spec/standalone-production-app`;
3. **done** — open promotion PR #13 `spec/standalone-production-app -> main`;
4. **in progress** — synchronize authoritative docs on the promotion head;
5. **required** — full `Bright Profile Verification` passes on the final exact PR #13 head/merge result;
6. **required** — resolve/record the real-browser keyboard/focus/console gate;
7. **required** — human explicitly approves the final promotion head;
8. **required** — merge PR #13 to `main` using an exact-head guard;
9. **required** — `main` push verification completes successfully.

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

The release-closure and source-branch gates are green and promotion PR #13 is open, but final promotion evidence is not yet complete.

### Gate status

- [x] release-closure PR #12 full workflow green on exact head;
- [x] release-closure decision explicitly authorized by the human release owner;
- [x] release-closure PR #12 merged into `spec/standalone-production-app`;
- [x] source-branch post-merge workflow `31825258653` green;
- [x] promotion PR #13 `spec/standalone-production-app -> main` opened;
- [x] authoritative project-status/spec/ship documentation synchronized to the promotion phase;
- [ ] final exact-head PR #13 full workflow green;
- [ ] real browser keyboard/focus/console smoke recorded as passing, or explicitly resolved by the human release owner;
- [ ] human explicitly approves the final PR #13 head;
- [ ] PR #13 merged to `main`;
- [ ] post-merge `main` push workflow green;
- [ ] rollback owner recorded if a persistent host deployment will follow.

Only after the applicable remaining gates pass should repository promotion be called **SHIP-ready / complete**.
