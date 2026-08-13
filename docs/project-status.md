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
6. durable worker orchestration for research/generation/TTS/render stages;
7. operator UI for create/status/review/approve/download;
8. removal of the remaining dependency on manually constructed project JSON and n8n-era orchestration assumptions.

## Current non-goals

Unless explicitly reintroduced later, the current MVP does **not** require:

- public SaaS or multi-tenant behavior;
- commercial launch readiness;
- public Plugins Directory submission;
- publisher/business verification or public legal/listing pages;
- Codex-specific plugin completion;
- ChatGPT desktop repo-marketplace acceptance;
- Kubernetes, multi-region infrastructure, or other scale architecture not needed by the internal workflow.

Security boundaries that protect external input, secrets, MCP requests, URL fetching, and rendered artifacts remain required even though public production launch is not a current goal.

## Documentation precedence

`docs/specs/standalone-production-app.md` and `tasks/todo.md` were written when the project was framed as a production-hardening initiative. Their **functional standalone workflow requirements remain useful**, but production/commercial launch requirements are superseded by `docs/specs/standalone-internal-mvp-amendment.md`.

When documentation conflicts, use this order for the current milestone:

1. `docs/project-status.md`
2. `docs/specs/standalone-internal-mvp-amendment.md`
3. existing standalone spec/plan/task files for functional details that are not superseded

## Next implementation focus

Do not add more plugin/Codex/marketplace surface. The next engineering work should resume the standalone application lifecycle, beginning with durable state/domain foundations and then the smallest vertical slice toward:

```text
creator/topic -> research -> review -> render -> MP4
```
