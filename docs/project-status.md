# Bright Profile — Current Project Status

**Status date:** 2026-08-14  
**Authoritative scope:** internal standalone app MVP for one operator/small internal team.  
**Lifecycle:** BUILD/VERIFY/REVIEW complete for T01–T16; SHIP closure in progress.

## Current objective

Promote the completed standalone internal MVP safely from `spec/standalone-production-app` to `main` after release-closure CI, documentation/spec alignment, ship audit, and human approval.

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

PR #11 completed T14–T16 and merged into `spec/standalone-production-app` on 2026-08-14.

The last pre-merge exact source tree was `d2470ba4290930df35dee7e20be58c972f88c46b`. GitHub Actions run `31799285582` completed successfully on commit `ec82a6fe551d34b1128fe9fa920b5edd0fe412bd`, which has that tree. The branch merge commit `9224107196606737c9b33c9788ef769376c628c7` has the same tree.

That verification covered frozen install, standalone/MCP production audits, SQLite migration smoke, full unit/integration tests, aggregate lint, Vite build, syntax checks, standalone API/UI health, MCP health, Remotion smoke, standalone Compose validation, real app/worker container boundary checks, MCP Compose/container verification, and teardown.

Fresh promotion evidence is still required before `main` merge. The verification workflow is being extended so both PRs targeting `main` and pushes to `main` run the same gate.

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
- the main standalone Compose host port is loopback-only by default and the worker publishes no HTTP port;
- provider credentials remain environment/deployment-secret concerns and are not persisted in application records or committed to Git.

## Frozen MVP contract and traceability

`tasks/traceability.md` is the closure ledger for the milestone and maps retained operations/invariants to owner tasks, implementation surfaces, focused regressions and final E2E/CI gates.

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

## Documentation precedence

When documentation conflicts, use this order for the current milestone:

1. `docs/project-status.md`
2. `docs/specs/standalone-internal-mvp-amendment.md` — consolidated active spec despite the legacy filename
3. `tasks/traceability.md`
4. `tasks/plan.md` and `tasks/todo.md`
5. `docs/specs/standalone-production-app.md` only as historical detail explicitly retained by the higher-precedence current-scope documents.

## Merge / release state

- T01–T16 implementation PRs are merged into `spec/standalone-production-app`.
- `spec/standalone-production-app` remains ahead of `main`; the standalone MVP has not yet been promoted to the default branch.
- A release-closure branch/PR owns the current ship audit, consolidated spec update, and CI promotion-trigger fix.
- Do not merge the promotion to `main` until the closure PR is green, the promotion PR itself receives fresh green CI, and a human approves the exact promotion head.
- No deployment is implied by merging to `main`; runtime deployment/rollback must follow the ship audit if/when an internal host is updated.

See `docs/ship/standalone-mvp-ship-audit.md` for current go/no-go evidence and rollback procedure.
