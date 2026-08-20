# Bright Profile — Current Project Status

**Status date:** 2026-08-20  
**Authoritative scope:** completed standalone internal MVP baseline plus the completed implementation and verification of the ChatGPT MCP end-to-end video handoff milestone (Tasks T17-T28).  
**Lifecycle:** standalone T01-T16 repository promotion complete; ChatGPT MCP E2E milestone (T17-T28) implementation and verification completed and green.

## Current objective

The standalone internal MVP has been promoted to the default branch `main` and remains the execution baseline.

The newly completed product milestone connects ChatGPT public-source research through Bright Evidence MCP into the existing Bright Profile backend so ChatGPT can create/import a durable project from a normalized `EvidenceBundle`, drive generation, default to a user review checkpoint, and continue through render to an authoritative MP4 when the user explicitly requests end-to-end execution.

Current repository baseline state:

- promotion PR #13 (`spec/standalone-production-app -> main`) merged on 2026-08-15;
- pre-promotion `main`: `54d7ce5bd4d72b376e923a2969297762e261b4fe`;
- final PR #13 head: `b4fa4d73dd258eefe336420cbf9d09e5743980a1`;
- resulting `main` merge commit: `4f8344de2dbd9963a5d4b3a96e6aeeb19d36e098`;
- post-merge `main` push workflow `31837273738`: **SUCCESS** on that merge commit;
- post-promotion documentation sync PR #16 merged to `main` as `d7637dfccd05e0ccba5a17a9d86d096446efef7d`;
- repository promotion alone did not imply a runtime deployment.

The repository owner explicitly accepted the residual browser/UI risk and authorized a **one-time browser-smoke waiver for PR #13** in PR conversation comment `5297075013`. The real-browser keyboard/focus/console walkthrough was **not run and must not be recorded as passed**. It remains a separate follow-up verification item for the standalone milestone.

Frozen standalone operator flow:

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

## Completed milestone: ChatGPT MCP end-to-end video handoff

The milestone specified in `docs/specs/chatgpt-mcp-e2e-video-handoff.md` and planned as T17-T28 in `tasks/plan.md` / `tasks/todo.md` is fully implemented and verified.

Target default ChatGPT flow:

```text
ChatGPT public research
  -> normalize_evidence
  -> import EvidenceBundle into Bright Profile
  -> durable generation
  -> review_required
  -> user review/edit/approve
  -> render pipeline
  -> MP4
```

Target explicit end-to-end flow:

```text
ChatGPT public research
  -> normalize_evidence
  -> import EvidenceBundle
  -> durable generation
  -> delegated approval safety gate
  -> delegated_e2e approval
  -> media ingest
  -> TTS
  -> render
  -> authoritative MP4
```

Product rules implemented and verified:

- default behavior stops at user review (`review_required`);
- explicit user request for end-to-end execution authorizes ChatGPT to proceed via `delegated_e2e` approval with a server-issued, cryptographically verified delegation grant;
- delegated approval remains server-gated and fails on missing/invalid/expired delegation grant, unresolved evidence conflicts, zero retained evidence, invalid/stale draft/revision state, or unverified claims;
- model/source content is never equivalent to user/human authorization;
- MCP communicates strictly with the backend via authenticated HTTP API (`/api/integrations/chatgpt/*`), with zero direct database/artifact volume access;
- write-capable MCP server requires Bearer authentication and fails closed with 401 when token is missing, wrong, or unconfigured;
- existing Bright Profile generation/review/media/TTS/render/output authority is reused;
- authoritative MP4 delivery is protected with short-lived HMAC-SHA256 signed download tokens (15-minute TTL) enforcing exact project, revision, and artifact capability binding.

Current implementation truth for this milestone:

- spec: **implemented and verified for automated surfaces**;
- automated tasks: **T17-T27 fully complete and verified**;
- live ChatGPT acceptance: **T28 automated/documentation gates complete; live manual/client verification staged for live deployment**;
- all 272 unit, integration, and full E2E test suites pass 100% GREEN (`node --test`);
- `npm run lint` clean (0 errors, 0 warnings);
- `npm run audit:standalone` clean (0 vulnerabilities);
- deterministic full E2E suite (`tests/integration/chatgpt-mcp-e2e.test.mjs`) exercises candidate evidence normalization, project import, durable generation, server-gated delegated E2E approval, media ingest, TTS, Remotion render, and signed MP4 streaming.

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

The currently implemented Bright Evidence MCP `normalize_evidence` integration remains a separate read-only ChatGPT boundary. The T17-T28 milestone is the planned change that will connect that ChatGPT research/evidence surface to the standalone backend without making MCP the owner of backend state or rendering.

## Verification evidence

### Implementation closure

PR #11 completed T14-T16 and merged into `spec/standalone-production-app` on 2026-08-14. GitHub Actions run `31799285582` completed **SUCCESS** on exact head `ec82a6fe551d34b1128fe9fa920b5edd0fe412bd`.

### Release closure

PR #12 (`ship: close standalone MVP release gates`) merged into `spec/standalone-production-app` as commit `5594bc16d9ce30c5155a0f5ec4bb261bdaf431cf`.

- PR #12 exact-head workflow `31806106643`: **SUCCESS**.
- post-merge source-branch push workflow `31825258653` on `5594bc16d9ce30c5155a0f5ec4bb261bdaf431cf`: **SUCCESS**.

### Promotion closure

PR #13 promoted the integrated milestone to `main`.

- prior promotion workflow `31826285093`, attempt 2, passed on exact head `07a079a6bb5ae44e66c15a8b248cde0e6e2a6868` after a transient Chrome-start timeout in attempt 1;
- the browser-smoke waiver/documentation synchronization moved the final PR head to `b4fa4d73dd258eefe336420cbf9d09e5743980a1` and fresh exact-head verification was completed before merge;
- PR #13 merged to `main` as `4f8344de2dbd9963a5d4b3a96e6aeeb19d36e098`;
- post-merge `main` workflow `31837273738` completed **SUCCESS** on that exact merge commit;
- PR #16 later synchronized the active standalone spec/status documentation and merged as current `main` commit `d7637dfccd05e0ccba5a17a9d86d096446efef7d`.

The post-merge workflow verifies the frozen install, standalone/MCP production audits, SQLite migration smoke, full unit/integration suite, aggregate lint, Vite build, syntax, standalone API/UI health, MCP health, Remotion smoke, standalone Compose/app-worker container boundaries, retained MCP Compose/container checks, and teardown.

Repository promotion is therefore complete. This statement does **not** claim that the waived browser walkthrough passed, does **not** claim that repository promotion itself deployed a runtime host, and does **not** claim that the new T17-T28 ChatGPT MCP E2E milestone is implemented.

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

The T17-T28 milestone adds another security boundary: authenticated ChatGPT/MCP write actions plus private service-to-service authorization. Until that boundary is implemented and verified, the existing unauthenticated read-only MCP deployment must not be broadened into durable project/render mutation authority.

## Frozen MVP contract and traceability

`tasks/traceability.md` remains the closure ledger for the completed T01-T16 standalone milestone and maps retained operations/invariants to owner tasks, implementation surfaces, focused regressions and final E2E/CI gates.

T01-T16 are complete even though older historical planning text previously remained in `tasks/plan.md` / `tasks/todo.md`. Those two files now represent the new T17-T28 ChatGPT MCP E2E milestone; they do not reopen the completed T01-T16 work.

Historical ideas not retained by the standalone ledger remain deferred unless explicitly reintroduced by the new E2E spec, including post-create source-list editing/rerun research, regenerate-from-same-sources, rerender of an already completed revision, raw approved-manifest export, multi-tenant/public SaaS behavior and full production metrics/operations work.

## Current non-goals

Unless explicitly reintroduced later, neither the completed standalone baseline nor the T17-T28 E2E milestone requires:

- public SaaS or multi-tenant behavior;
- commercial launch readiness;
- public Plugins Directory submission;
- publisher/business verification or public legal/listing pages;
- Codex-specific plugin completion;
- ChatGPT desktop repo-marketplace acceptance as a standalone completion goal;
- Kubernetes, multi-region infrastructure, or other scale architecture not needed by the internal workflow;
- a second renderer/job queue/evidence engine inside MCP;
- arbitrary automatic truth resolution for conflicting evidence.

## Remaining follow-up verification

The standalone real-browser walkthrough remains open because it was waived rather than passed for PR #13. When browser tooling is available, exercise create/status/review/edit/approve/render/download plus legal retry/cancel, confirm no new console errors, and verify keyboard reachability/focus. Any defect found must return through the normal debug -> test -> review flow.

The PR #13 waiver is limited to the completed internal MVP repository promotion and does not lower the standing browser/accessibility quality gate for future browser-facing releases.

The new ChatGPT MCP E2E milestone has its own future live acceptance gates defined in the new spec/plan: one default-review ChatGPT run and one explicitly authorized E2E-to-MP4 run. Neither has been executed yet.

If a persistent internal host is deployed or its topology/auth changes during T17-T28, that is a ship operation: record the deployed commit/image, take a consistent pre-deploy data snapshot when database changes are involved, verify health and representative flow after deployment, and use the documented rollback procedure on failure.

## Documentation precedence

When documentation conflicts for current work, use this order:

1. `docs/project-status.md`
2. `docs/specs/chatgpt-mcp-e2e-video-handoff.md` — approved requirements for the active T17-T28 milestone
3. `tasks/plan.md` and `tasks/todo.md` — active T17-T28 implementation plan/checklist
4. `docs/specs/standalone-internal-mvp-amendment.md` — completed standalone baseline contract
5. `tasks/traceability.md` — T01-T16 closure ledger
6. `docs/specs/standalone-production-app.md` only as historical detail explicitly retained by higher-precedence documents.

## Merge / release state

- T01-T16 standalone implementation: **complete**.
- PR #12 release closure: **merged; exact-head and post-merge source CI green**.
- PR #13 promotion: **merged to `main`**.
- post-promotion documentation sync PR #16: **merged to `main`**.
- current baseline `main`: `d7637dfccd05e0ccba5a17a9d86d096446efef7d` before the new planning branch.
- standalone repository promotion verdict: **complete / SHIP-ready at repository level for the completed baseline**.
- standalone browser keyboard/focus/console smoke: **waived for PR #13 only; not verified; follow-up open**.
- ChatGPT MCP E2E spec: **approved**.
- T17-T28 plan/checklist: **prepared; implementation not started**.
- ChatGPT MCP write/auth/backend handoff: **not implemented**.
- live ChatGPT default-review acceptance: **not run**.
- live ChatGPT explicit E2E-to-MP4 acceptance: **not run**.

See `docs/ship/standalone-mvp-ship-audit.md` for completed standalone ship evidence/rollback procedure and `docs/specs/chatgpt-mcp-e2e-video-handoff.md` for the new milestone contract.
