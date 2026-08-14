# Ship Audit: Standalone Bright Profile Internal MVP

**Audit date:** 2026-08-14  
**Target source branch:** `spec/standalone-production-app`  
**Target destination:** `main`  
**Current decision:** **HOLD / NO-GO for promotion until the remaining gates below are satisfied.**

## Scope

This audit is for shipping the frozen **internal standalone MVP** into the repository default branch. It is not a public/commercial production launch and does not authorize broader network exposure or deployment to an external environment.

The retained flow is:

`create -> research -> generate -> review/edit -> approve -> render-start -> media ingest -> TTS -> render -> download`

## Exact baseline

At audit start:

- `spec/standalone-production-app` head: `9224107196606737c9b33c9788ef769376c628c7`;
- source tree: `d2470ba4290930df35dee7e20be58c972f88c46b`;
- `main` head: `54d7ce5bd4d72b376e923a2969297762e261b4fe`;
- `spec/standalone-production-app` is ahead of `main` by 392 commits and behind by 0;
- no promotion PR to `main` existed at audit start.

The branch head is the merge commit for PR #11. Its tree is identical to PR #11 exact head `ec82a6fe551d34b1128fe9fa920b5edd0fe412bd`.

## Verified evidence

GitHub Actions run `31799285582` completed **SUCCESS** on PR #11 exact head `ec82a6fe551d34b1128fe9fa920b5edd0fe412bd`, which has the same source tree as the integrated branch head.

The successful job covered:

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
- teardown;
- retained MCP Compose and isolated MCP container checks.

PR #11's final independent re-review reported P0=0, P1=0, P2=0 and **APPROVE** on the verified exact tree.

## Findings and closure work

### Required — promotion PR did not trigger the verification workflow

Before this audit, `.github/workflows/mcp-verify.yml` ran pull-request verification only when the PR base was `spec/standalone-production-app`. A promotion PR targeting `main` therefore would not receive the same fresh release gate.

**Closure:** the release-closure branch updates the workflow to run on:

- pull requests targeting `spec/standalone-production-app`;
- pull requests targeting `main`;
- pushes to `spec/standalone-production-app`;
- pushes to `main`;
- the existing standalone/MCP build branches.

This change must itself pass the existing full workflow before it is merged into the source branch.

### Required — current spec contained stale pre-implementation status

The active internal-MVP amendment still described durable state, research, generation, UI, and the n8n-independent workflow as not yet implemented even though T01–T16 are now integrated.

**Closure:** the legacy amendment path is converted into a consolidated active spec with objective, current stack, exact commands, project structure, code style, testing strategy, boundaries, success criteria, implementation status, and open release questions.

### Required — project status contained stale merge state

`docs/project-status.md` still said T11–T16 were awaiting merge even though PR #10 and PR #11 had already merged.

**Closure:** current status is updated to BUILD/VERIFY/REVIEW complete and SHIP closure in progress.

### Required for `/ship` — rollback plan was intentionally deferred until a real ship task

The frozen planning ledger explicitly deferred a release/rollback runbook while the project was not being shipped. `/ship` has now been invoked, so a rollback path is required.

**Closure:** the rollback procedure is defined below.

### Pending evidence — real browser accessibility/interaction walkthrough

The repository has UI state/control regressions, semantic keyboard behavior in the reviewed implementation, Vite production build, and built-web health checks. However this audit did not find evidence of a real interactive browser walkthrough covering the complete supported operator flow and keyboard/focus behavior.

The current ChatGPT environment does not expose a local browser/DevTools session for this repository, so this check is **not executed here**.

**Required before final GO:** a human or available browser runner should exercise the built UI at minimum for create/status/review/edit/approve/render/download plus legal retry/cancel, confirm no new console errors, and check keyboard reachability/focus for interactive controls. Record the result on the release-closure or promotion PR.

## Definition of Done audit

### Correctness

- **Verified:** T01–T16 behavior has focused unit/integration regressions and deterministic standalone E2E evidence on the integrated source tree.
- **Verified:** retry/cancel/reclaim/heartbeat/approval-race and output integrity paths were part of PR #11 closure evidence.
- **Pending:** fresh CI for the release-closure head and later for the exact promotion head.

### Quality

- **Verified:** aggregate lint and syntax checks passed on the integrated source tree.
- **Verified:** final PR review found no remaining correctness/security/architecture/simplicity/performance blocker.
- **Pending:** closure diff review after documentation/workflow changes.

### Integration

- **Verified:** standalone app/worker Compose topology, SQLite migrations, shared volume, health endpoints, Remotion smoke and MCP regression boundary passed CI.
- **Pending:** promotion PR merge-result CI against `main`.

### Documentation

- **Previously stale:** current spec and merge state.
- **Closure branch:** consolidated spec, current status, and this ship audit align documentation to the release candidate.

### Security

- **Verified:** standalone and MCP dependency audits passed on the integrated source tree.
- **Verified:** SSRF-safe fetch, model-output distrust, artifact path/ownership, non-root containers, loopback app publish, non-published worker and read-only worker credential mount are retained contract/verification gates.
- **No scope expansion:** closure work does not broaden auth, network, provider, data, or filesystem permissions.

### Observability / operations

For this internal private/loopback milestone, the retained contract uses health endpoints, persisted stage/error state, request IDs, and deterministic recovery rather than a full production SLO/metrics platform. Full public-production observability remains out of scope.

If the app is intentionally exposed beyond the trusted internal boundary, a new auth/TLS/observability ship task is required first.

### Accessibility

- **Automated/static evidence:** UI state/control tests and production build exist.
- **Not verified in this audit:** real browser keyboard/focus/console walkthrough.
- **Ship gate:** pending manual/browser evidence as described above.

## CI / promotion policy

The release sequence is:

1. merge the release-closure PR into `spec/standalone-production-app` only after its full verification workflow is green and a human approves the exact head;
2. open `spec/standalone-production-app -> main`;
3. require the same full `Bright Profile Verification` workflow to pass on the promotion PR merge result;
4. review the promotion as a frozen release delta; no feature work should be added there;
5. merge to `main` only with exact-head human approval;
6. require the `push` verification workflow on `main` to complete successfully after merge.

A green historical PR run is supporting evidence, not a substitute for steps 1–6.

## Rollback plan

### Repository integration rollback

Merging to `main` is repository integration only; no deployment workflow exists in `.github/workflows` at audit time.

Before promotion merge, record:

- current `main` SHA;
- promotion PR exact head SHA;
- merge method used.

If the merged default-branch change must be rolled back:

1. do not force-push shared `main`;
2. create a revert PR that reverses the promotion merge/squash commit;
3. run the same full verification workflow on the revert PR;
4. merge the revert only after green CI and human review;
5. verify the post-revert `main` push workflow.

### Runtime deployment rollback

No runtime deployment is performed by this audit.

If a persistent internal host is later updated to this release:

1. record the currently deployed commit/image before changing it;
2. stop application writers and take a consistent backup/snapshot of the `bright-data` volume, including `bright-profile.sqlite` and authoritative artifacts;
3. deploy the new image/commit;
4. verify `/health/live`, `/health/ready`, UI load, and one representative critical flow before declaring the host healthy;
5. roll back on data-integrity/security failure, repeated new error class, broken health/readiness, or inability to produce/download an authoritative MP4;
6. redeploy the previously recorded image/commit;
7. if the older code cannot safely operate on the migrated SQLite state, restore the pre-deploy data snapshot instead of attempting an unproven destructive down migration.

Current migrations are additive, but this audit does **not** claim a tested automatic database down-migration path.

## GO / NO-GO gate

### Current verdict: HOLD / NO-GO

The implementation tree has strong prior verification and review evidence, but promotion is not yet authorized because release-specific evidence is incomplete.

### GO requires all of the following

- [ ] release-closure PR full workflow is green on its exact head/merge result;
- [ ] release-closure diff receives human approval;
- [ ] real browser keyboard/focus/console smoke is recorded as passing;
- [ ] release-closure PR is merged into `spec/standalone-production-app`;
- [ ] promotion PR `spec/standalone-production-app -> main` is opened with no unrelated feature delta;
- [ ] promotion PR full workflow is green on the exact merge result;
- [ ] human approves the exact promotion head;
- [ ] rollback owner is known if a persistent host deployment will follow;
- [ ] post-merge `main` push workflow completes successfully.

Only after these gates pass should the repository promotion be called **SHIP-ready**.
