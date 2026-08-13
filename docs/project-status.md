# Bright Profile — Current Project Status

**Status date:** 2026-08-13  
**Authoritative scope:** internal standalone app MVP for one operator/small internal team.

## Current objective

Replace the remaining n8n-era orchestration with a standalone internal workflow that starts from a creator name/topic plus optional public URLs and ends with a reviewed, rendered MP4.

Target flow:

```text
creator/topic
  -> public-source research
  -> normalized evidence
  -> structured claims/script/scene plan
  -> human review + approval
  -> approved media ingest
  -> Google TTS
  -> Remotion render
  -> MP4
```

## Completed foundation

The repository already has a usable execution foundation:

- Remotion creator-profile composition and reusable scene types;
- Google Cloud TTS integration;
- MP4 rendering through Remotion/Chromium/FFmpeg;
- Docker/runtime baseline and render smoke coverage;
- API-key protected render job/status/download endpoints;
- Bright Evidence MCP `normalize_evidence`;
- remote MCP deployment at `https://video.lanadesign.tech/mcp`;
- live ChatGPT tool discovery and an observed successful `normalize_evidence` invocation;
- deterministic evidence normalization/deduplication with structured `EvidenceBundle` output.

The ChatGPT ↔ MCP integration is considered complete for the current internal scope.

## Standalone MVP work still missing

The project is **not yet complete end-to-end**. The remaining functional work is:

1. durable project/job state that survives process/container restart;
2. creator/topic public-source research orchestration;
3. structured generation of claims, script, voiceover chunks, and Remotion scene plan;
4. persisted human review/edit/approval workflow;
5. approved media ingest into trusted local artifacts;
6. durable worker orchestration for research/generation/media-ingest/TTS/render stages;
7. operator UI for create/status/review/approve/render/download;
8. standalone render-start/output-download/health HTTP operations required by the operator flow;
9. removal of the remaining dependency on manually constructed project JSON and n8n-era orchestration assumptions.

## Frozen MVP contract and traceability

`tasks/traceability.md` is the closure ledger for this milestone. It maps every retained observable operation and cross-cutting invariant to:

`requirement/source -> owner task -> implementation surface -> focused regression -> final E2E/CI gate`.

The current required operator flow is frozen to:

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

It also retains retry/cancel, approval/downstream race safety, SSRF-safe fetch, source provenance, provider/schema validation, durable lease/recovery/fencing, safe artifact handling, standalone dependency audit, aggregate lint/build/E2E, private Compose, health endpoints, and existing MCP regressions.

Historical functional ideas that are not retained in the traceability matrix are deferred for this MVP rather than silently becoming completion gates. Examples include post-create source-list editing/rerun research, regenerate-from-same-sources, rerender of an already completed revision, raw approved-manifest export, and full production metrics/operations work.

## Current non-goals

Unless explicitly reintroduced later, the current MVP does **not** require:

- public SaaS or multi-tenant behavior;
- commercial launch readiness;
- public Plugins Directory submission;
- publisher/business verification or public legal/listing pages;
- Codex-specific plugin completion;
- ChatGPT desktop repo-marketplace acceptance;
- Kubernetes, multi-region infrastructure, or other scale architecture not needed by the internal workflow.

Security boundaries that protect external input, secrets, MCP requests, URL fetching, rendered artifacts, and dependencies executed by the app/worker remain required even though public production launch is not a current goal.

## Documentation precedence

`docs/specs/standalone-production-app.md` was written when the project was framed as a production-hardening initiative. Its historical functional detail is retained only where the active internal scope explicitly keeps it.

When documentation conflicts, use this order for the current milestone:

1. `docs/project-status.md`
2. `docs/specs/standalone-internal-mvp-amendment.md`
3. `tasks/traceability.md` for the frozen retained-operation/invariant ledger
4. `tasks/plan.md` and `tasks/todo.md` for implementation decomposition
5. `docs/specs/standalone-production-app.md` only as historical detail that is not superseded and is explicitly retained by the current scope ledger

A requirement present only in the historical production spec is **not** a current MVP gate unless it is retained by the higher-precedence current-scope documents above.

## Next implementation focus

Do not add more plugin/Codex/marketplace surface. After the revised plan and traceability closure are approved, the next engineering work should resume the standalone application lifecycle from durable state/domain foundations and build toward:

```text
creator/topic -> research -> review -> render -> MP4
```
