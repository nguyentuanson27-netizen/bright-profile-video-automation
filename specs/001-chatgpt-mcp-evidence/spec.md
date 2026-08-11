# Spec 001 — ChatGPT Research → MCP Normalize + Deduplicate Evidence

**Status:** Draft  
**Date:** 2026-08-11  
**Branch:** `spec/mcp-public-research-evidence`

## 1. Summary

Add a remote MCP server to `bright-profile-video-automation` so ChatGPT can be used as the research agent for public sources, then pass collected evidence through a deterministic normalization/deduplication layer before the evidence is used for scripting or video generation.

Target flow:

```text
User
  |
  v
ChatGPT / Deep Research
  |  research public web sources
  |  extract atomic evidence + source metadata
  v
Bright Evidence MCP
  |  normalize
  |  canonicalize URLs
  |  exact + near deduplicate
  |  group conflicts
  |  score source/evidence quality
  v
EvidenceBundle JSON
  |
  +--> ChatGPT: script / outline / fact check
  |
  +--> Bright app pipeline
          |
          v
      existing Remotion renderer
```

There is **no n8n dependency** in this target architecture. Existing n8n references in repository documentation/configuration are treated as legacy deployment context and are outside this spec.

## 2. Why this split

ChatGPT should do what it is good at:

- research public sources;
- formulate search strategies;
- understand pages and context;
- extract candidate claims;
- preserve citations and relevant excerpts.

The MCP service should do what should be repeatable and testable:

- validate the evidence envelope;
- normalize URLs and metadata;
- normalize claim text and typed values;
- identify exact duplicates;
- cluster near-duplicates;
- preserve every source supporting a retained claim;
- detect contradictory evidence;
- return a stable JSON contract.

The MCP server must **not call OpenAI again in v1**. Research happens in ChatGPT. This avoids duplicated model/web-search costs and keeps the MCP component deterministic.

## 3. Goals

1. Connect ChatGPT to a remote MCP endpoint owned by this project.
2. Use ChatGPT/Deep Research to research public sources.
3. Expose a read-only/pure MCP tool named `normalize_evidence`.
4. Produce atomic, normalized evidence with explicit provenance.
5. Deduplicate syndicated/repeated evidence without losing source coverage.
6. Preserve conflicts instead of silently selecting a winner.
7. Return a machine-readable `EvidenceBundle` that can later feed script and video generation.
8. Keep research/evidence logic separate from the existing renderer.
9. Make normalization deterministic enough to unit test without an LLM.

## 4. Non-goals

- n8n orchestration.
- Using the MCP server itself as a web crawler/search engine in v1.
- Calling the OpenAI API from the MCP server in v1.
- Persisting a permanent evidence database in v1.
- Writing to external systems from ChatGPT.
- Scraping content behind authentication/paywalls or bypassing access controls.
- Researching private profiles/private social content.
- Automatically publishing videos.
- Modifying Remotion scene design/render behavior in this spec.

## 5. OpenAI / ChatGPT constraints

As of 2026-08-11, the implementation must assume:

- ChatGPT custom apps can connect to MCP-backed tools.
- ChatGPT connects directly to remote MCP servers; private/local development servers require an approved tunnel mechanism rather than direct localhost connectivity.
- Deep Research can use custom MCP apps for read/fetch behavior, not write actions.
- Therefore `normalize_evidence` must be a pure/read-only transformation with no durable side effect.

OpenAI references:

- https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt
- https://help.openai.com/en/articles/11487775-connectors-in-chatgpt

## 6. Proposed repository shape

```text
bright-profile-video-automation/
  mcp/
    server.mjs
    tools/
      normalize-evidence.mjs
    schemas/
      evidence-input.schema.json
      evidence-bundle.schema.json
  lib/
    evidence/
      canonical-url.mjs
      normalize-text.mjs
      normalize-value.mjs
      fingerprint.mjs
      deduplicate.mjs
      conflicts.mjs
      score-evidence.mjs
  test/
    evidence/
      canonical-url.test.mjs
      deduplicate.test.mjs
      conflicts.test.mjs
  examples/
    evidence-input.json
    evidence-bundle.json
  specs/
    001-chatgpt-mcp-evidence/
      spec.md
```

The current `server.mjs` remains the render/API process. The MCP process is separate so it can have a different exposure/authentication policy and failure domain.

## 7. ChatGPT research contract

Before calling MCP, ChatGPT should convert research into **candidate evidence items**, not a prose report.

Each item should represent one atomic factual assertion.

Good:

```text
"Creator X reached 2.1 million Twitch followers by 2026-07-01."
```

Bad:

```text
"Creator X became popular, gained millions of followers, collaborated with Y, and later moved platforms."
```

Every candidate must include at least:

- `claim`
- `url`

Whenever available, ChatGPT should also provide:

- source title;
- publisher;
- publication date;
- author;
- short supporting excerpt;
- source type;
- claim category;
- typed value and unit;
- date the claim refers to.

## 8. MCP tool

### `normalize_evidence`

**Purpose:** transform caller-provided public-source evidence into a normalized, deduplicated `EvidenceBundle`.

**Side effects:** none. No durable storage.  
**Network access:** not required for v1.  
**Idempotent:** yes for identical input + normalizer version.

### 8.1 Input

```json
{
  "subject": {
    "name": "Emiru",
    "aliases": ["Emily Schunk"]
  },
  "researchQuery": "career milestones, breakout moments, audience metrics and recent activity",
  "researchedAt": "2026-08-11T08:00:00Z",
  "items": [
    {
      "claim": "Example atomic factual claim.",
      "url": "https://example.com/article?utm_source=x",
      "title": "Example article",
      "publisher": "Example",
      "author": "Author Name",
      "publishedAt": "2026-07-01T00:00:00Z",
      "excerpt": "Short passage that directly supports the claim.",
      "category": "audience_metric",
      "sourceType": "news",
      "claimDate": "2026-07-01",
      "value": 2100000,
      "unit": "followers"
    }
  ],
  "options": {
    "maxEvidence": 80,
    "nearDuplicateThreshold": 0.86
  }
}
```

### 8.2 Validation rules

- `subject.name`: required, 1–200 chars.
- `items`: required, 1–200 items per call.
- `claim`: required, 3–2000 chars.
- `url`: required absolute `http` or `https` URL.
- `excerpt`: optional, maximum 1500 chars.
- `publishedAt`: optional ISO-8601.
- `claimDate`: optional ISO date or ISO-8601.
- `value`: optional string/number/boolean.
- unknown fields may be ignored in v1 but must not affect the fingerprint.
- reject the whole request only for malformed envelope/schema; reject individual bad evidence records into `rejectedItems[]` where safe.

## 9. EvidenceBundle output

```json
{
  "schemaVersion": "1.0",
  "normalizerVersion": "1.0.0",
  "subject": {
    "name": "Emiru",
    "aliases": ["Emily Schunk"]
  },
  "researchedAt": "2026-08-11T08:00:00Z",
  "stats": {
    "inputItems": 12,
    "retainedEvidence": 7,
    "exactDuplicatesRemoved": 2,
    "nearDuplicatesMerged": 3,
    "conflictGroups": 1,
    "rejectedItems": 0
  },
  "evidence": [
    {
      "id": "ev_01...",
      "claim": "Normalized atomic claim.",
      "claimNormalized": "normalized atomic claim",
      "category": "audience_metric",
      "claimDate": "2026-07-01",
      "value": 2100000,
      "unit": "followers",
      "fingerprint": "sha256:...",
      "qualityScore": 0.91,
      "confidence": "high",
      "conflictGroupId": null,
      "sources": [
        {
          "url": "https://example.com/article",
          "canonicalUrl": "https://example.com/article",
          "title": "Example article",
          "publisher": "Example",
          "author": "Author Name",
          "publishedAt": "2026-07-01T00:00:00Z",
          "excerpt": "Short supporting passage.",
          "sourceType": "news"
        }
      ]
    }
  ],
  "conflicts": [],
  "rejectedItems": []
}
```

## 10. Normalization pipeline

The order is significant.

### Step 1 — sanitize strings

For matching/fingerprints only:

- Unicode NFKC;
- trim outer whitespace;
- collapse repeated whitespace;
- normalize smart quotes/dashes where unambiguous;
- lowercase comparison form;
- preserve original human-readable values separately.

Do not remove meaningful digits, `%`, currency symbols, minus signs, dates, or units.

### Step 2 — canonicalize URL

Create `canonicalUrl` using these rules:

1. lowercase scheme + hostname;
2. remove fragment;
3. remove default ports;
4. normalize trailing slash except root;
5. sort query parameters;
6. remove known tracking parameters:
   - `utm_*`
   - `gclid`
   - `fbclid`
   - `mc_cid`
   - `mc_eid`
   - `ref` only when configured as a tracking key for the domain;
7. preserve query parameters that can change resource identity;
8. never follow redirects in v1.

URL canonicalization alone is not evidence deduplication.

### Step 3 — normalize publisher/domain

- lowercase hostname for matching;
- strip leading `www.` for publisher-domain comparison;
- keep original display publisher when provided;
- infer publisher from hostname only if publisher is absent.

### Step 4 — normalize typed values

Normalize only when confidently parseable.

Examples:

- `2.1M`, `2.1 million` -> `2100000`
- `86K` -> `86000`
- `12%` -> `{ value: 12, unit: "percent" }`
- dates -> ISO date/ISO-8601
- currency -> numeric value + ISO currency code only when currency is explicit

Do not infer USD from `$` if source context makes currency ambiguous.

### Step 5 — create claim comparison form

`claimNormalized` is used only for matching. It may:

- lowercase;
- normalize punctuation/whitespace;
- normalize explicit numeric abbreviations;
- normalize obvious date formatting;
- replace known subject aliases with the canonical subject token.

It must not paraphrase using an LLM.

### Step 6 — exact dedupe

Exact duplicate if either condition is true:

A. same `canonicalUrl` + same normalized claim; or  
B. same deterministic evidence fingerprint.

Fingerprint material:

```text
subjectCanonical
category
claimDateNormalized
valueNormalized
unitNormalized
claimNormalized
```

Hash with SHA-256.

When duplicates merge:

- keep one evidence record;
- union source records;
- never discard distinct canonical source URLs;
- prefer non-null metadata;
- keep the longest directly supporting excerpt up to the configured cap.

### Step 7 — near-duplicate clustering

Near-duplicate matching is deterministic in v1; no embeddings and no model call.

Candidate pairs should first pass blocking rules:

- same subject;
- compatible category;
- if both have typed values, values must be equal within category-specific tolerance;
- if both have claim dates, dates must be compatible.

Then compute token-set similarity on `claimNormalized`.

Default merge threshold: `0.86`.

Important guardrails:

- never merge claims with different explicit numeric values outside tolerance;
- never merge positive and negated claims;
- never merge claims whose dates make them materially different snapshots;
- source similarity must not be used as the sole reason to merge.

### Step 8 — source syndication handling

If multiple articles repeat the same claim, merge them into one evidence record with multiple `sources[]`.

Set optional `sourceRelationship` when deterministic evidence exists:

- `primary`
- `independent`
- `syndicated`
- `quotes_primary`
- `unknown`

V1 does not need to discover citation graphs automatically. ChatGPT may supply this hint and the normalizer may preserve it.

## 11. Conflict detection

A conflict is not a duplicate.

Create a conflict group when evidence shares a comparable fact key but has incompatible values.

Suggested `factKey`:

```text
subject + category + metric/entity + claimDate bucket
```

Examples:

- source A says `2.1M followers`, source B says `2.4M` for the same platform/date;
- source A gives an event date of July 4, source B gives July 5;
- one source says a partnership ended, another says it remains active.

Output:

```json
{
  "id": "conf_01...",
  "factKey": "emiru:twitch_followers:2026-07-01",
  "evidenceIds": ["ev_a", "ev_b"],
  "status": "unresolved"
}
```

Do not auto-delete lower-scoring contradictory evidence. Downstream ChatGPT can reason over the conflict with citations visible.

## 12. Evidence quality score

`qualityScore` is a ranking hint, not truth probability.

Range: `0.0–1.0`.

Suggested deterministic components:

- 0.30 source directness;
- 0.25 source type/authority;
- 0.20 excerpt support completeness;
- 0.15 metadata completeness;
- 0.10 freshness when freshness is relevant to the category.

Suggested source-type priors:

1. official/primary source;
2. first-party interview/direct transcript;
3. high-quality reporting with named sourcing;
4. platform analytics/profile page;
5. secondary reporting;
6. aggregator/repost;
7. anonymous/unclear provenance.

Do not hard-code a global whitelist of "trusted domains" in v1.

## 13. Confidence label

Confidence is derived from evidence structure, not from model intuition.

- `high`: strong direct source OR 2+ independent good sources, no unresolved material conflict.
- `medium`: one credible secondary source or partially indirect support.
- `low`: weak/indirect source, incomplete support, or unresolved material conflict.

The normalizer may downgrade but must never upgrade solely because many syndicated URLs repeat the same claim.

## 14. MCP response ergonomics

The tool result should contain:

1. machine-readable structured content containing the full `EvidenceBundle`;
2. a concise text summary for ChatGPT, for example:

```text
Normalized 38 candidates into 21 evidence records.
Merged 11 exact/near duplicates.
Found 2 unresolved conflict groups.
Use evidence IDs and source URLs when drafting factual claims.
```

Do not return only prose.

## 15. MCP server behavior

### Transport

Use a remote MCP transport supported by ChatGPT. Production must be reachable by ChatGPT or connected through the supported secure tunnel path for a private deployment.

### Tool annotation / behavior

`normalize_evidence` should be explicitly described as:

- read-only/pure;
- deterministic;
- no durable data mutation;
- processes only data included in the tool request;
- does not browse or fetch URLs in v1.

### Limits

Initial limits:

- request body: 2 MB;
- max evidence candidates: 200;
- max claim length: 2000 chars;
- max excerpt length: 1500 chars;
- max sources per merged evidence: 20;
- processing timeout: 10 seconds.

Oversized requests should fail with a structured validation error so ChatGPT can split the evidence into batches.

## 16. Authentication and deployment

MCP must be deployed separately from the render API.

Recommended production shape:

```text
ChatGPT
  |
  | HTTPS / MCP auth
  v
mcp.<domain>
  |
  v
bright-evidence-mcp container

private app network
  |
  +--> bright-profile-api container
```

For v1 the MCP service does not need access to `bright-profile-api` at all.

Requirements:

- TLS at the edge;
- no secrets committed to Git;
- auth appropriate for the chosen ChatGPT MCP app setup;
- rate limiting;
- structured request IDs in logs;
- do not log full excerpts by default;
- do not expose renderer download/job endpoints through MCP.

## 17. Prompt-injection boundary

Public web content is untrusted.

ChatGPT is responsible for treating instructions found inside sources as source content, not as system/user instructions.

The MCP normalizer further reduces risk by being non-agentic:

- it does not execute source text;
- it does not fetch URLs;
- it does not call shell commands;
- it does not call another model;
- claim/excerpt strings are treated as inert data.

## 18. ChatGPT usage template

Recommended operator prompt after the MCP app is connected:

```text
Research public sources about {{SUBJECT}}.
Focus on {{QUESTIONS}}.

Requirements:
- prefer primary/direct sources where available;
- separate each factual finding into one atomic claim;
- attach the exact source URL to every claim;
- keep distinct dates/metrics as distinct claims;
- do not hide disagreements between sources;
- after research, call the Bright Evidence MCP normalize_evidence tool;
- use the returned EvidenceBundle as the factual basis for the rest of the answer;
- when drafting, cite the sources attached to each retained evidence item.
```

## 19. Example deduplication

Input:

```json
[
  {
    "claim": "X had 2.1M followers on July 1, 2026.",
    "url": "https://news-a.example/story?utm_source=x",
    "value": 2100000,
    "unit": "followers",
    "claimDate": "2026-07-01"
  },
  {
    "claim": "By 1 July 2026, X had 2.1 million followers.",
    "url": "https://news-b.example/repost",
    "value": 2100000,
    "unit": "followers",
    "claimDate": "2026-07-01"
  }
]
```

Expected output: one retained evidence record with two source records, provided normalized claim similarity passes the near-duplicate threshold.

If the second item says `2.4 million`, expected output is two evidence records in one unresolved conflict group, not one merged record.

## 20. Downstream contract for video generation

The renderer must never receive raw research as factual truth by implication.

A future script/video planning layer should reference evidence IDs explicitly:

```json
{
  "sceneId": "stats-1",
  "claim": "X reached 2.1 million followers by July 1, 2026.",
  "evidenceIds": ["ev_01..."],
  "sourceUrls": ["https://example.com/article"]
}
```

This makes it possible to audit every factual scene back to retained evidence.

## 21. Acceptance criteria

### AC-1 — ChatGPT connection

Given a deployed remote MCP server, ChatGPT can scan and expose the `normalize_evidence` tool in a custom app/developer setup.

### AC-2 — Pure transform

Calling `normalize_evidence` with valid input performs no durable write and produces the same semantic output for repeated identical inputs under the same normalizer version.

### AC-3 — URL normalization

Tracking-only URL variants collapse to the same canonical URL without dropping query parameters that identify different resources.

### AC-4 — Exact dedupe

Identical claims from duplicate URL variants produce one evidence record.

### AC-5 — Near dedupe

Paraphrases with the same typed value/date/category merge above the configured similarity threshold.

### AC-6 — Numeric conflict protection

Claims with materially different explicit numeric values do not merge.

### AC-7 — Citation preservation

When duplicates merge, all distinct canonical source URLs remain attached to the retained evidence.

### AC-8 — Conflict grouping

Contradictory comparable claims remain separate and are linked through `conflictGroupId` / `conflicts[]`.

### AC-9 — No LLM dependency

All unit tests for normalization/deduplication run without an OpenAI API key and without network access.

### AC-10 — Renderer isolation

Existing rendering behavior continues to work without requiring the MCP process.

## 22. Test fixtures required

Include fixtures for:

- UTM/query canonicalization;
- trailing slash/default port variants;
- exact duplicate claim;
- paraphrased same claim;
- same metric different value;
- same metric different date;
- negated claim;
- `2.1M` vs `2.1 million`;
- multiple independent sources;
- syndicated sources;
- malformed URL;
- missing optional metadata;
- mixed Vietnamese/English evidence for the same fact.

## 23. Implementation sequence

1. Add JSON schemas and fixtures.
2. Implement URL/text/value normalization.
3. Implement deterministic fingerprints.
4. Implement exact dedupe.
5. Implement guarded near-duplicate clustering.
6. Implement conflict grouping.
7. Implement quality/confidence calculation.
8. Add MCP server exposing only `normalize_evidence`.
9. Add unit/integration tests.
10. Deploy remote MCP endpoint and connect it in ChatGPT developer/custom-app settings.
11. Run an end-to-end creator research test from ChatGPT.

## 24. Future extensions

Explicitly deferred from v1:

- `fetch_evidence_bundle(id)` with durable storage;
- evidence review/approval states;
- automatic primary-source graph detection;
- embedding-based semantic clustering;
- screenshot/archive capture;
- claim-to-script generation service;
- direct scene-plan generation;
- automatic renderer submission;
- private source connectors.

Any future write-capable MCP tool must be specified separately with explicit confirmation/authz/audit behavior.
