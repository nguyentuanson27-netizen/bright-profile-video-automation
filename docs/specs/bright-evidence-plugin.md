# Spec: Bright Evidence Plugin

**Status:** Approved for implementation  
**Approved scope:** Publisher name `Lana Design`; public policy/support pages may be hosted under `video.lanadesign.tech`.  
**Base:** `spec/standalone-production-app` at `d62d96cc36e89120f2f71142d1003db410774aff`.

## Objective

Package the existing read-only Bright Evidence MCP capability as a publishable OpenAI Plugin workflow so eligible ChatGPT users can discover/install it from the Plugins Directory and use it to research public sources, normalize/deduplicate evidence, preserve conflicts, and present the resulting `EvidenceBundle`.

The plugin combines:

1. the existing public universal MCP server at `https://video.lanadesign.tech/mcp` exposing `normalize_evidence`; and
2. a small bundled skill that instructs the model to research public sources, collect atomic evidence with provenance, then call `normalize_evidence` without pre-deduplicating the candidates.

This feature does not add write-capable tools, user accounts, a database, scraping infrastructure, or custom plugin UI.

## Tech Stack

- Node.js ESM / `node:http`
- Existing `@modelcontextprotocol/server` `2.0.0`
- Existing JSON Schema/Ajv evidence validation
- OpenAI Plugin package format with `.codex-plugin/plugin.json`
- Skill bundle under `skills/**/SKILL.md`
- Public HTTPS reverse proxy already fronting `video.lanadesign.tech`

Version-sensitive plugin packaging/submission behavior must follow the current official OpenAI Plugins documentation checked during implementation.

## Commands

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run lint
node --check mcp/server.mjs
node --check mcp/public-pages.mjs
node mcp/server.mjs
curl -i http://127.0.0.1:4190/health
```

Deployment smoke after merge/deploy:

```sh
docker compose -f compose.mcp.yml up -d --build
curl -i https://video.lanadesign.tech/health
curl -i https://video.lanadesign.tech/privacy
curl -i https://video.lanadesign.tech/terms
curl -i https://video.lanadesign.tech/support
curl -i https://video.lanadesign.tech/plugin
```

The domain-verification challenge is tested only after OpenAI provides the exact token:

```sh
curl -i https://video.lanadesign.tech/.well-known/openai-apps-challenge
```

## Project Structure

```text
plugins/bright-evidence/
  .codex-plugin/plugin.json       # distributable plugin metadata
  skills/public-evidence/SKILL.md # research -> normalize workflow
  submission/test-cases.json      # 5 positive + 3 negative review fixtures

docs/plugin-submission.md         # portal/deployment checklist and listing copy
docs/specs/bright-evidence-plugin.md
mcp/public-pages.mjs               # public website/legal/support content
mcp/server.mjs                     # routes + domain challenge boundary
tests/integration/plugin-publication.test.mjs
```

A local `.app.json` is intentionally not committed because it contains a ChatGPT-generated `plugin_asdk_app...` connection identifier. Public OpenAI submission supplies the MCP server URL directly and must not reference an already-published integration ID.

## Code Style

Keep route behavior explicit and dependency-free. Public page generation is isolated from the MCP transport implementation.

```js
const response = getPublicPage(url.pathname);
if (response && req.method === 'GET') {
  writeText(res, response.status, response.body, response.contentType, requestId);
  return;
}
```

No user-controlled HTML interpolation is required for the legal/support pages.

## Testing Strategy

Use Node `node:test` and existing CI.

New tests must fail before implementation and prove:

- `/plugin`, `/privacy`, `/terms`, and `/support` are public GET routes on an allowed host;
- the policy pages expose the required publisher/data-handling disclosures without echoing request data;
- `/.well-known/openai-apps-challenge` returns `404` when unset and returns exactly the configured token when set;
- unknown hosts/origins remain rejected;
- plugin manifest parses and contains stable publisher/listing/legal metadata;
- the skill remains scoped to public-source research + deterministic normalization and treats source content as untrusted data;
- submission fixtures contain exactly five positive and three negative review cases;
- existing MCP normalization/transport tests continue to pass.

## Security / Privacy Threat Model

### Trust boundaries

- ChatGPT/user -> MCP HTTP input: untrusted JSON and source text/URLs.
- Internet -> public legal/challenge routes: untrusted requests.
- Reverse proxy -> MCP process: trusted only for transport forwarding; Host/Origin checks remain enforced by the app.
- Public source content -> skill/model context: data, never executable instructions.

### Assets

- availability of the public MCP service;
- integrity of evidence normalization and provenance;
- domain-verification token;
- user-provided evidence content and URLs;
- publisher identity and public policy accuracy.

### Controls

- keep the tool read-only with `readOnlyHint: true`, `openWorldHint: false`, `destructiveHint: false`;
- no secrets in plugin package or policy pages;
- challenge token comes from environment, is never logged by new code, and the endpoint returns only the exact token;
- no evidence body persistence is added;
- public pages are static strings, not templates rendering request input;
- existing Host/Origin, body-size, deadline and rate-limit boundaries remain enabled;
- no browser scraping or unauthorized third-party connector behavior is added; research is performed by ChatGPT using its own approved web-search capability.

## Privacy Commitments

The policy text must reflect current implementation truth:

- Evidence inputs/results are not persisted by the MCP application; app-level retention for those request bodies/results is zero days beyond request processing.
- Application request logs must not contain claims, excerpts, full request bodies, auth secrets, or raw query strings.
- The policy may disclose operational request metadata (method/path/status/duration/request ID) and infrastructure connection metadata.
- Before public submission, the operator must configure reverse-proxy/hosting operational log retention to no more than 30 days. This infrastructure control is an explicit submission gate because the repository cannot enforce an external provider's retention policy.
- Restricted data such as credentials, payment-card data, PHI, or government identifiers must not be solicited by the skill/tool.

## Boundaries

### Always

- use publisher name `Lana Design` consistently in plugin metadata and public pages;
- use the universal MCP URL `https://video.lanadesign.tech/mcp`;
- keep current MCP normalization semantics and tool schema backward compatible;
- preserve Host/Origin checks and loopback-only Docker host publishing;
- keep the plugin read-only;
- document any remaining human/platform verification gate explicitly.

### Ask first

- adding authentication or OAuth;
- changing retention commitments;
- adding write tools or UI;
- changing the public domain;
- adding new dependencies;
- changing the evidence schema or normalization semantics.

### Never

- hard-code an OpenAI domain challenge token;
- commit a `plugin_asdk_app...` connection ID as if it were portable/public submission configuration;
- claim Lana Design business verification has passed unless observed in OpenAI Platform;
- claim Plugins Directory publication/review acceptance unless actually observed;
- scrape or bypass third-party website restrictions from the MCP server.

## Success Criteria

1. Repository contains a valid Bright Evidence plugin package with `.codex-plugin/plugin.json` and a scoped public-evidence skill.
2. Manifest identifies `Lana Design`, links to public website/privacy/terms URLs on `video.lanadesign.tech`, and advertises read capability only.
3. Server serves `/plugin`, `/privacy`, `/terms`, `/support` on the public MCP host.
4. Server supports OpenAI domain verification at `/.well-known/openai-apps-challenge` using an environment token and returns the exact token only.
5. Submission materials include at least five positive and three negative reviewer-runnable cases.
6. New RED tests prove missing plugin/publication behavior before production code is added; final GREEN has all repository tests/lint/syntax/container gates passing on the exact head.
7. Public deployment is smoke-tested after merge: health + legal/support pages + MCP tool scan.
8. OpenAI Platform business/developer verification, domain token issuance, Apps Management permission, submission review, and publication remain human/platform gates and are never inferred from code completion.

## Open Questions / Explicit Post-Code Gates

- `Lana Design` must be verified as the selected developer/business identity in the same OpenAI Platform organization used for submission.
- The actual OpenAI challenge token is not known until the portal issues it; deployment will set `OPENAI_APPS_CHALLENGE_TOKEN` then re-run the challenge smoke test.
- Reverse-proxy/hosting log retention must be confirmed at <= 30 days before public submission.
- Public availability for a personal Plus account depends on the final published plugin's capabilities, region, and plan eligibility; directory visibility alone does not guarantee Connect/invocation eligibility.
