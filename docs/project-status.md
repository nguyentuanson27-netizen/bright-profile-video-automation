# Bright Profile — Current Project Status

**Status date:** 2026-08-15  
**Authoritative scope:** internal standalone app MVP for one operator/small internal team.  
**Lifecycle:** DEFINE/PLAN/BUILD/VERIFY/REVIEW/SHIP repository promotion complete for T01–T16; real-browser follow-up remains open.

## Current objective

The standalone internal MVP has been promoted to the default branch `main`.

Current repository state:

- promotion PR #13 (`spec/standalone-production-app -> main`) merged on 2026-08-15;
- pre-promotion `main`: `54d7ce5bd4d72b376e923a2969297762e261b4fe`;
- final PR #13 head: `b4fa4d73dd258eefe336420cbf9d09e5743980a1`;
- resulting `main` merge commit: `4f8344de2dbd9963a5d4b3a96e6aeeb19d36e098`;
- post-merge `main` push workflow `31837273738`: **SUCCESS** on that merge commit;
- no runtime deployment is implied by this repository promotion.

The repository owner explicitly accepted the residual browser/UI risk and authorized a **one-time browser-smoke waiver for PR #13** in PR conversation comment `5297075013`. The real-browser keyboard/focus/console walkthrough was **not run and must not be recorded as passed**. It remains the one visible follow-up verification item for this milestone.

Frozen operator flow:

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

## Implemented standalone surface

The promoted implementation includes:

- durable SQLite project/source/revision/stage/attempt/artifact state with migrations and restart-safe reopen;
- lease, heartbeat, claim-token fencing, bounded retry, cancel, reclaim and stale-owner rejection;
- creator/topic public-source research and normalized evidence/source provenance;
- structured generation of claims, script, voiceover chunks and supported Remotion scenes;
- local schema/reference/timeline validation of model output and explicit distrust of model verification/override assertions;
- structured human review/edit and immutable approval with edit-vs-downstream serialization;
- approved-media ingest through the SSRF-safe fetch boundary into application-owned attempt paths;
- source/revision-bound media manifests plus authoritative artifact size/SHA-256 metadata;
- durable Google TTS and Remotion render stages with retry/cancel/recovery semantics;
- normal renderer inputs restricted to application-controlled local media with Chromium web security enabled;
- authoritative completed-output MP4 download with fixed route and path/size/hash revalidation;
- React/Vite same-origin operator UI for create, status, research, evidence/conflicts, draft review/edit, approve, render, retry, cancel and download;
- standalone Docker image and two-service Compose topology: loopback-published app + non-published worker sharing one named data volume;
- removal of n8n and manually constructed project JSON from the normal operator workflow;
- deterministic fake-provider full-flow regression that reaches a downloadable authoritative MP4 without remote provider calls;
- frontend build, aggregate lint, dependency audit, health, render smoke, Compose/container and MCP regression gates in CI.

The Bright Evidence MCP `normalize_evidence` integration remains available as a separate read-only ChatGPT boundary and is not required to expose the standalone app publicly.

## Verification evidence

### Implementation closure

PR #11 completed T14–T16 and merged into `spec/standalone-production-app` on 2026-08-14. GitHub Actions run `31799285582` completed **SUCCESS** on exact head `ec82a6fe551d34b1128fe9fa920b5edd0fe412bd`.

### Release closure

PR #12 (`ship: close standalone MVP release gates`) merged into `spec/standalone-production-app` as commit `5594bc16d9ce30c5155a0f5ec4bb261bdaf431cf`.

- PR #12 exact-head workflow `31806106643`: **SUCCESS**.
- post-merge source-branch push workflow `31825258653` on `5594bc16d9ce30c5155a0f5ec4bb261bdaf431cf`: **SUCCESS**.

### Promotion closure

PR #13 promoted the integrated milestone to `main`.

- prior promotion workflow `31826285093`, attempt 2, passed on exact head `07a079a6bb5ae44e66c15a8b248cde0e6e2a6868` after a transient Chrome-start timeout in attempt 1;
- the browser-smoke waiver/documentation synchronization moved the final PR head to `b4fa4d73dd258eefe336420cbf9d09e5743980a1` and fresh exact-head verification was completed before merge;
- PR #13 merged to `main` as `4f8344de2dbd9963a5d4b3a96e6aeeb19d36e098`;
- post-merge `main` workflow `31837273738` completed **SUCCESS** on that exact merge commit.

The post-merge workflow verifies the frozen install, standalone/MCP production audits, SQLite migration smoke, full unit/integration suite, aggregate lint, Vite build, syntax, standalone API/UI health, MCP health, Remotion smoke, standalone Compose/app-worker container boundaries, retained MCP Compose/container checks, and teardown.

Repository promotion is therefore complete. This statement does **not** claim that the waived browser walkthrough passed and does **not** claim a runtime host was deployed.

## Security and integrity boundaries retained

The internal scope still requires fail-closed security at external and persistence boundaries:

- public URL/media fetches are SSRF-safe and bounded by DNS/IP, redirect, MIME, byte and timeout policies;
- provider/model output is untrusted and cannot own application IDs, claim human verification, or inject managed media paths;
- remote filenames never choose local storage paths;
- approved revision identity and artifact provenance are carried through media/TTS/render;
- stale/reclaimed/cancelled workers cannot publish authoritative artifacts;
- every approved media file is revalidated by byte size and SHA-256 before render;
- the completed MP4 is published only after successful current-owner validation and is revalidated before download;
- normal Remotion execution does not disable Chromium web security and does not accept arbitrary remote/file media refs;
- the standalone Compose host port is loopback-only by default and the worker publishes no HTTP port;
- provider credentials remain environment/deployment-secret concerns and are not persisted in application records or committed to Git.

## Frozen MVP contract and traceability

`tasks/traceability.md` remains the closure ledger for the milestone and maps retained operations/invariants to owner tasks, implementation surfaces, focused regressions and final E2E/CI gates.

T01–T16 are complete even though older checkbox wording in `tasks/plan.md` / `tasks/todo.md` remains a historical planning artifact. Current completion truth is governed by this status document, the active spec, and the traceability ledger rather than unchecked historical planning boxes.

Historical ideas not retained by that ledger remain deferred, including post-create source-list editing/rerun research, regenerate-from-same-sources, rerender of an already completed revision, raw approved-manifest export, multi-tenant/public SaaS behavior and full production metrics/operations work.

## Current non-goals

Unless explicitly reintroduced later, the MVP does **not** require:

- public SaaS or multi-tenant behavior;
- commercial launch readiness;
- public Plugins Directory submission;
- publisher/business verification or public legal/listing pages;
- Codex-specific plugin completion;
- ChatGPT desktop repo-marketplace acceptance;
- Kubernetes, multi-region infrastructure, or other scale architecture not needed by the internal workflow.

## Remaining follow-up verification

The real-browser walkthrough remains open because it was waived rather than passed for PR #13. When browser tooling is available, exercise create/status/review/edit/approve/render/download plus legal retry/cancel, confirm no new console errors, and verify keyboard reachability/focus. Any defect found must return through the normal debug -> test -> review flow.

The PR #13 waiver is limited to the completed internal MVP repository promotion and does not lower the standing browser/accessibility quality gate for future releases.

If a persistent internal host is deployed later, that is a separate ship operation: record the deployed commit/image, take a consistent pre-deploy data snapshot, verify health and representative flow after deployment, and use the documented rollback procedure on failure.

## Documentation precedence

When documentation conflicts, use this order for the current milestone:

1. `docs/project-status.md`
2. `docs/specs/standalone-internal-mvp-amendment.md` — consolidated active spec despite the legacy filename
3. `tasks/traceability.md`
4. `tasks/plan.md` and `tasks/todo.md`
5. `docs/specs/standalone-production-app.md` only as historical detail explicitly retained by the higher-precedence current-scope documents.

## Merge / release state

- T01–T16 implementation: **complete**.
- PR #12 release closure: **merged; exact-head and post-merge source CI green**.
- PR #13 promotion: **merged to `main`**.
- `main` promotion merge commit: `4f8344de2dbd9963a5d4b3a96e6aeeb19d36e098`.
- post-merge `main` workflow `31837273738`: **SUCCESS**.
- repository promotion verdict: **complete / SHIP-ready at repository level**.
- browser keyboard/focus/console smoke: **waived for PR #13 only; not verified; follow-up open**.
- runtime deployment: **not performed by repository promotion**.

See `docs/ship/standalone-mvp-ship-audit.md` for ship evidence and rollback procedure.
