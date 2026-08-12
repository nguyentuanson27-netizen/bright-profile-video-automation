# Spec: Bright Evidence Internal Plugin

**Status:** Approved after scope correction  
**Base:** `spec/standalone-production-app`  
**Distribution:** Internal/private only

## Objective

Package the existing Bright Evidence capability as an internal ChatGPT/Codex plugin for the Bright Profile project so an internal user can research public sources, collect atomic evidence with provenance, and delegate deterministic normalization/deduplication/conflict preservation to the existing `normalize_evidence` MCP tool.

This feature is for project/team use. It is **not** a public Plugins Directory submission, commercial product, or production-readiness initiative.

## Intended flow

```text
ChatGPT internal workflow
  -> public-evidence skill
  -> registered Bright Evidence MCP connection
  -> https://video.lanadesign.tech/mcp
  -> normalize_evidence
  -> EvidenceBundle
```

## In scope

- keep the existing remote read-only MCP server and `normalize_evidence` contract unchanged;
- package the `public-evidence` skill with a minimal plugin manifest;
- expose the plugin through the repository-local marketplace;
- document the account/workspace-specific MCP connection wiring step;
- retain existing security boundaries and regression verification.

## Explicit non-goals

- public Plugins Directory publication;
- commercial distribution or monetization;
- public listing/privacy/terms/support pages;
- domain-verification challenge endpoints;
- public submission reviewer fixtures, release notes, logo, publisher/business verification, or submission workflow;
- new write tools, database persistence, scraping, UI, auth system, or normalization-core changes.

## Connection portability

The repository must not hard-code a `plugin_asdk_app...` technical connection ID. The MCP connection is registered in the user's account/workspace and then mapped locally for that installation. The shared package remains portable until that local mapping is created.

## Security invariants

- `normalize_evidence` remains read-only and deterministic;
- external source text is untrusted data, never executable instruction;
- no credentials, private restricted data, shell, renderer, database, or another model are exposed through the tool;
- Host/Origin validation, request limits, sanitized logging, and loopback-only Docker host publishing stay intact;
- public/restricted sites are not scraped or accessed by bypassing controls.

## Acceptance criteria

1. Plugin manifest is minimal internal metadata and contains the bundled skill.
2. `.agents/plugins/marketplace.json` exposes exactly the Bright Evidence plugin as a local/private source.
3. Public submission-only routes and challenge configuration are absent.
4. Existing MCP server behavior and remote configuration are unchanged.
5. Skill preserves provenance, treats source content as untrusted, and does not pre-deduplicate before `normalize_evidence`.
6. Repository tests, lint, syntax, MCP health, Compose boundary, container isolation, and render smoke remain green.
7. Live plugin acceptance is limited to registering the MCP connection, wiring the generated connection ID locally, installing from the internal marketplace, and observing an actual `normalize_evidence` call. It does not require public publication.
