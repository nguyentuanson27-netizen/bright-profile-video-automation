# Bright Evidence MCP

This repository exposes one MCP tool for ChatGPT research workflows:

- `normalize_evidence` — a read-only, deterministic transform for caller-provided public-source evidence.

The MCP process does not browse, call an LLM, write to the Bright database, execute source content, or invoke the renderer. The existing render API remains independent.

## Run locally

```bash
npm ci
npm run mcp
```

Default endpoint: `http://127.0.0.1:4190/mcp`  
Health: `http://127.0.0.1:4190/health`

Configuration:

```text
MCP_HOST=127.0.0.1
MCP_PORT=4190
MCP_ALLOWED_HOSTS=127.0.0.1,localhost
MCP_MAX_BODY_BYTES=2097152
MCP_RATE_LIMIT_PER_MINUTE=60
MCP_REQUEST_TIMEOUT_MS=10000
```

Non-finite or non-positive numeric safety settings fall back to their documented defaults. In particular, an invalid `MCP_MAX_BODY_BYTES` value cannot disable the default 2 MB request-body boundary.

`MCP_REQUEST_TIMEOUT_MS` is an end-to-end application deadline for the `/mcp` request path: it starts before request-body collection and the remaining budget is then applied to MCP handler processing. A stalled upload therefore cannot consume an unbounded body-read phase outside the configured request deadline. Timeout responses close the connection after the response is written. Crossing `MCP_MAX_BODY_BYTES` also pauses body collection, returns `413`, and closes the connection rather than draining an oversized remainder indefinitely.

Request logs intentionally record the sanitized URL pathname only. Query parameters are not persisted in the `mcp.request` log event.

Production should keep the process on loopback/private networking. ChatGPT does not connect directly to localhost; for a private deployment use OpenAI Secure MCP Tunnel or an authenticated remote HTTPS MCP endpoint. Do not expose this process on `0.0.0.0` merely to make local testing work.

## ChatGPT tool contract

`normalize_evidence` accepts a subject plus 1–200 candidate evidence items. Each valid item requires an atomic `claim` and absolute public `http(s)` source URL. Malformed individual items are reported under `rejectedItems` when safe; malformed envelopes are rejected.

The MCP `tools/list` contract is generated from the same checked-in JSON Schemas used by runtime Ajv validation. The advertised input schema includes the known evidence-item fields, types, limits, and descriptions. Its item schema also has a permissive fallback so one malformed candidate can still reach item-level validation and be returned under `rejectedItems` instead of causing the whole MCP call to fail. The advertised output schema exposes the structured shapes for `evidence`, `conflicts`, and `rejectedItems` rather than unknown arrays.

`sourceRelationship` is constrained to the deterministic vocabulary `primary`, `independent`, `quotes_primary`, `syndicated`, or `unknown`. Independence is opt-in: only sources explicitly marked `independent` count toward the two-independent-sources confidence rule. Missing or `unknown` relationship metadata does not imply independence.

The result contains both a short text summary and structured `EvidenceBundle` content. Numeric/date guards prevent materially different facts from being merged; conflicts remain separate and are linked through unresolved conflict groups. Missing `category` is treated as unknown/compatible for conflict comparison rather than disabling conflict detection; metric/entity, unit, date, and value guards still prevent unrelated uncategorized facts from being grouped.

Public source text is inert data. Instruction-looking claim/excerpt text has no permissions and is never executed.

## Text and numeric normalization

Subject names and aliases are replaced only at Unicode letter/number token boundaries. Short aliases therefore do not rewrite substrings inside unrelated words such as `announcement`, `listed`, `live`, or `LinkedIn`.

Numeric normalization is conservative when no locale/number-format signal exists:

- a single separator followed by exactly three digits is considered ambiguous (`1,234`, `1.234`, `2,100K`) and remains textual;
- one or two digits after a single comma may be treated as a decimal comma (`2,1M` → `2100000`, `12,5%` → `12.5 percent`);
- ordinary dot decimals with one or two fractional digits remain supported (`2.1M`, `12.5%`);
- repeated comma thousands groups or comma-grouping plus an explicit dot decimal remain parseable when structurally unambiguous;
- strings that do not match a supported unambiguous form stay textual rather than being forced into a number.

Near-deduplication also compares deterministic numeric markers derived from `claimNormalized` after removing explicit date spans in the claim. When callers omit the optional `value` field, a single unambiguous numeric claim value can still guard dedupe and participate in conflict detection. Different explicit claim numbers are never near-merged merely because the surrounding wording is highly similar.

## Source preservation and overflow

Distinct canonical sources are preserved through deduplication before the output cap is applied. The `EvidenceBundle` output allows at most 20 `sources[]` entries per retained evidence record.

When duplicate evidence points to the same canonical URL, every emitted source field is merged with an input-order-independent policy. The raw tracking-variant URL is selected lexically for stable output. Inferred hostname publishers and the default `sourceType: other` cannot override stronger explicit provenance; explicit source types are compared by the existing source prior. `title`, `author`, and `excerpt` prefer the longer non-empty text, with lexical order as a deterministic tie-break. Conflicting explicit `publishedAt` values retain the earlier timestamp so freshness is conservative rather than order-dependent. Conflicting explicit source-relationship labels collapse to `unknown` instead of asserting a stronger relationship by order.

When more than 20 distinct canonical source URLs support one evidence record:

1. all distinct sources are collected before output selection;
2. the emitted subset is selected deterministically by source-type prior, source-relationship prior, supporting excerpt length, provenance metadata completeness, then canonical URL;
3. the selected 20 are sorted by `canonicalUrl` for stable output;
4. `omittedSourceCount` reports the exact number of additional distinct canonical sources not emitted because of the output cap;
5. `qualityScore` and `confidence` are computed only from the emitted/auditable source subset.

This makes source overflow explicit and prevents confidence from depending on provenance that the returned bundle cannot cite. The source-overflow amendment under `specs/001-chatgpt-mcp-evidence/amendments/` supersedes the original AC-7 wording for the >20-source case.

## Conflict identity

Conflict detection uses a deterministic comparable-fact identity rather than category/date alone. The normalizer derives a metric/entity signature from `claimNormalized` after removing subject markers, numeric/date tokens, month names, unit tokens, and common grammatical/metric scaffolding. Small deterministic lexical aliases normalize ordinary variants such as singular/plural audience units and `joined`/`joining`/`joins`.

The conflict fact key combines:

```text
subject + category-or-uncategorized + metric/entity signature + unit + claim-date bucket
```

V1 still deliberately avoids semantic similarity, embeddings, or an LLM for conflict identity. Ordinary wording noise such as possessive `s`, `count`, `total`, `metric`, `milestone`, or `organization` does not create a different identity, while entity anchors such as `Twitch`, `Instagram`, or `Acme` remain part of the signature. This allows normal paraphrases of the same metric/event to conflict without reintroducing the broad-category Twitch-vs-Instagram false positive.

`claimDate` has two deterministic roles:

- when a typed or safely inferred claim value exists, differing claim dates are treated as different snapshots and are not compared as the same numeric fact;
- when neither side has a comparable value, differing `claimDate` values are treated as a disputed event date only when each normalized claim explicitly contains its own year, month, and day. Otherwise the dates remain separate snapshots and do not create a conflict merely because they differ.

A detected event-date disagreement uses the `event-date-disputed` bucket so both evidence records remain linked while retaining their original `claimDate` values.

## `maxEvidence` retention policy

`maxEvidence` is applied only after exact/near deduplication, deterministic source selection, quality scoring, and unresolved conflict detection have completed across the full retained candidate set.

Retention is deterministic:

1. Each unresolved conflict group is an atomic retention unit. All detected conflict groups are retained before non-conflicting singleton evidence.
2. `maxEvidence` is a target cap for ordinary retention, not permission to erase an unresolved contradiction. If preserving a complete conflict group requires more records than `maxEvidence`, the normalizer exceeds the requested cap rather than dropping the group or emitting only one side.
3. After all conflict members are retained, any remaining budget up to `maxEvidence` is filled with non-conflicting evidence ranked by `qualityScore` descending, then fingerprint ascending.
4. Final `evidence[]` and `conflicts[]` ordering is stable by fingerprint/group ID so identical input and normalizer version produce identical output.

This makes `qualityScore` a ranking hint while keeping detected contradictions visible downstream. `stats.retainedEvidence` reports the actual retained count, which may therefore be greater than `options.maxEvidence` only when required to preserve unresolved conflict groups.

## Production dependency verification

CI installs from the authoritative root lockfile with lifecycle scripts disabled and runs `npm audit --omit=dev --audit-level=high --json` as a production dependency gate. The MCP image still uses the selected root production lock graph for this PR; the audit result is therefore directly applicable to the packages installed into that image. A later packaging optimization may split a minimal MCP-only lockfile, but it must not weaken frozen installs or advisory verification.

The audit verifier treats the npm JSON report as an untrusted boundary: it requires the expected report version, vulnerability object, complete non-negative vulnerability metadata counts, consistency between metadata and finding severities, and a compatible raw `npm audit` exit status before applying the exact advisory allowlist. Parseable error/incomplete JSON is therefore a gate failure rather than an empty clean report.
