# Bright Profile — Current Project Status

**Status date:** 2026-08-15  
**Authoritative scope:** internal standalone app MVP for one operator/small internal team.  
**Lifecycle:** DEFINE/PLAN/BUILD/VERIFY/REVIEW complete for T01–T16; SHIP promotion to `main` in progress.

## Current objective

Promote the completed standalone internal MVP safely from `spec/standalone-production-app` to the default branch `main` through promotion PR #13, with fresh exact-head CI and explicit human approval before merge.

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

The current implementation includes:

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

PR #11 completed T14–T16 and merged into `spec/standalone-production-app` on 2026-08-14. GitHub Actions run `31799285582` completed **SUCCESS** on exact head `ec82a6fe551d34b1128fe9fa920b5edd0fe412bd`, source tree `d2470ba4290930df35dee7e20be58c972f88c46b`.

That verification covered frozen install, standalone/MCP production audits, SQLite migration smoke, full unit/integration tests, aggregate lint, Vite build, syntax checks, standalone API/UI health, MCP health, Remotion smoke, standalone Compose validation, real app/worker container boundary checks, MCP Compose/container verification, and teardown.

### Release closure

PR #12 (`ship: close standalone MVP release gates`) merged into `spec/standalone-production-app` as commit `5594bc16d9ce30c5155a0f5ec4bb261bdaf431cf`.

- PR #12 exact-head workflow `31806106643`: **SUCCESS**.
- post-merge source-branch push workflow `31825258653` on `5594bc16d9ce30c5155a0f5ec4bb261bdaf431cf`: **SUCCESS**.
- the workflow now verifies PRs targeting `main` and pushes to `main` in addition to the retained integration/build gates.

### Promotion

Promotion PR #13 is open from `spec/standalone-production-app` to `main`.

Promotion workflow `31826285093`, attempt 2, completed **SUCCESS** on exact head `07a079a6bb5ae44e66c15a8b248cde0e6e2a6868`, including the full test/audit/build/render/Compose/container gate. The earlier attempt-1 Chrome-connect timeout did not reproduce, so no runtime change was made for that transient failure.

The repository owner then explicitly accepted the residual browser/UI risk and authorized a **one-time browser-smoke waiver for PR #13** in PR conversation comment `5297075013`. The real-browser keyboard/focus/console walkthrough was **not run and must not be recorded as passed**. It remains a visible follow-up verification item after promotion.

Because this waiver/status synchronization changes the promotion documentation head, the resulting final exact head must receive a fresh full `Bright Profile Verification` before merge. Historical green runs, including `31826285093`, remain supporting evidence only after the head moves.

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

## Follow-up verification retained after promotion

The real-browser walkthrough remains an explicit follow-up because it was waived rather than passed for PR #13. When browser tooling is available, exercise create/status/review/edit/approve/render/download plus legal retry/cancel, confirm no new console errors, and verify keyboard reachability/focus. Any defect found must return through the normal debug -> test -> review flow.

The PR #13 waiver is limited to this internal MVP repository promotion and does not lower the standing browser/accessibility quality gate for future releases.

## Documentation precedence

When documentation conflicts, use this order for the current milestone:

1. `docs/project-status.md`
2. `docs/specs/standalone-internal-mvp-amendment.md` — consolidated active spec despite the legacy filename
3. `tasks/traceability.md`
4. `tasks/plan.md` and `tasks/todo.md`
5. `docs/specs/standalone-production-app.md` only as historical detail explicitly retained by the higher-precedence current-scope documents.

## Merge / release state

- T01–T16 implementation is complete on `spec/standalone-production-app`.
- PR #12 release closure is merged and both exact-head and post-merge source-branch CI are green.
- Promotion PR #13 (`spec/standalone-production-app -> main`) is open.
- `main` has **not** yet received the standalone MVP.
- Browser keyboard/focus/console smoke is **not verified** for PR #13; the owner explicitly accepted that residual risk as a one-time waiver and the follow-up remains open.
- Do not merge PR #13 until the final documentation-sync head receives fresh full `Bright Profile Verification` and explicit human approval.
- After merge, the `main` push workflow must complete successfully before repository promotion is called complete.
- No deployment is implied by merging to `main`; runtime deployment/rollback must follow the ship audit if/when an internal host is updated.

See `docs/ship/standalone-mvp-ship-audit.md` for current go/no-go evidence and rollback procedure.
