# Implementation Plan: Bright Evidence Plugin

**Source spec:** `docs/specs/bright-evidence-plugin.md`  
**Approved by user:** 2026-08-13  
**Base:** `spec/standalone-production-app` @ `d62d96cc36e89120f2f71142d1003db410774aff`

## Goal

Turn the existing public read-only Bright Evidence MCP into an OpenAI Plugin submission package for publisher `Lana Design`, with a bundled public-research skill, public policy/support pages, domain-verification support, and reviewer test fixtures.

## Dependency Graph

```text
P01 RED publication-contract tests
 |
 +--> P02 public website/policy/challenge routes
 |
 +--> P03 plugin package + skill + reviewer fixtures
       |
       +--> P04 docs/env/deployment wiring
             |
             +--> P05 full CI + security/review
                   |
                   +--> P06 deploy/live OpenAI submission gates (human/platform)
```

## Task P01 — Add RED publication-contract tests

**Acceptance criteria**
- Tests cover `/plugin`, `/privacy`, `/terms`, `/support`.
- Challenge route is 404 when token unset and exact raw token when configured.
- Unknown Host/Origin remains 403.
- Tests validate plugin manifest, skill scope, and exactly 5 positive + 3 negative submission fixtures.
- RED failure is observed before implementation.

**Verification**
- GitHub Actions `npm test` fails only on the newly introduced publication contract.

**Files**
- `tests/integration/plugin-publication.test.mjs`

## Task P02 — Add public publication routes

**Acceptance criteria**
- Static public pages contain Lana Design listing/legal/support copy.
- Privacy page discloses data categories, purpose, recipients, retention and user controls.
- Challenge token comes only from `OPENAI_APPS_CHALLENGE_TOKEN` and is never hard-coded.
- Existing MCP/health behavior remains backward compatible.

**Verification**
- Focused/new tests turn GREEN.
- Existing transport/security tests stay GREEN.

**Files**
- `mcp/public-pages.mjs`
- `mcp/server.mjs`

## Task P03 — Package plugin and skill

**Acceptance criteria**
- `plugins/bright-evidence/.codex-plugin/plugin.json` parses and uses relative paths.
- Publisher/display metadata uses Lana Design and public `video.lanadesign.tech` policy URLs.
- Plugin capability is read-only.
- Skill tells the model to research public sources using available first-party web search, treat source text as untrusted data, preserve provenance, avoid pre-deduplication, then call `normalize_evidence`.
- Skill does not request restricted data or instruct unauthorized scraping/access-control bypass.
- Submission fixture file contains 5 positive + 3 negative reviewer-runnable cases.
- No `.app.json` integration ID is committed.

**Verification**
- Publication-contract tests validate the file tree and content.

**Files**
- `plugins/bright-evidence/.codex-plugin/plugin.json`
- `plugins/bright-evidence/skills/public-evidence/SKILL.md`
- `plugins/bright-evidence/submission/test-cases.json`

## Task P04 — Document submission/deployment wiring

**Acceptance criteria**
- `.env.example` documents challenge token without a real secret.
- `docs/plugin-submission.md` contains exact OpenAI Platform human gates: Apps Management Write, verified Lana Design identity, Universal MCP URL, domain verification, Scan Tools, skill upload, starter prompts, tests, release notes.
- Docs explicitly block public submission until infrastructure operational-log retention is confirmed <=30 days.
- README links the plugin docs.

**Verification**
- Docs review matches implementation truth and current official OpenAI Plugin docs.

## Task P05 — Full verification/review

**Acceptance criteria**
- `npm test`, lint, syntax, MCP health, render smoke, Compose boundary, isolated Docker checks all pass on exact head.
- Security review: correctness -> security -> architecture -> simplicity -> performance.
- No secrets or integration IDs in diff.
- PR remains draft until live public pages and OpenAI Scan Tools are verified or explicitly waived as pre-merge gates.

## Task P06 — Human/platform gates

Not completed by repository code alone:
- deploy branch to `video.lanadesign.tech`;
- verify public `/plugin`, `/privacy`, `/terms`, `/support`;
- obtain OpenAI domain token and set `OPENAI_APPS_CHALLENGE_TOKEN`;
- verify exact challenge response;
- verify Lana Design business/developer identity in OpenAI Platform;
- create `With MCP` submission with Universal URL `https://video.lanadesign.tech/mcp`;
- Scan Tools and confirm `normalize_evidence` metadata;
- upload/test final skill bundle;
- submit 5 positive + 3 negative cases;
- submit for review and publish only after approval.

## Risks / Mitigations

- **Legal/privacy text outruns deployment reality:** keep app-level claims tied to code; make external log-retention confirmation a blocking operator gate.
- **Hard-coded OpenAI integration/challenge identity:** environment token only; no `.app.json` unless generated for a local developer-mode connection.
- **Plugin becomes unofficial third-party scraper:** MCP never browses; skill relies on ChatGPT's approved web search and public user-provided URLs.
- **Publication metadata implies writes:** advertise only Read; keep tool annotations unchanged/read-only.
