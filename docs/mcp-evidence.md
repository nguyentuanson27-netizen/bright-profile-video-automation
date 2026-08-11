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

Production should keep the process on loopback/private networking. ChatGPT does not connect directly to localhost; for a private deployment use OpenAI Secure MCP Tunnel or an authenticated remote HTTPS MCP endpoint. Do not expose this process on `0.0.0.0` merely to make local testing work.

## ChatGPT tool contract

`normalize_evidence` accepts a subject plus 1–200 candidate evidence items. Each valid item requires an atomic `claim` and absolute public `http(s)` source URL. Malformed individual items are reported under `rejectedItems` when safe; malformed envelopes are rejected.

The MCP `tools/list` contract is generated from the same checked-in JSON Schemas used by runtime Ajv validation. The advertised input schema includes the known evidence-item fields, types, limits, and descriptions. Its item schema also has a permissive fallback so one malformed candidate can still reach item-level validation and be returned under `rejectedItems` instead of causing the whole MCP call to fail. The advertised output schema exposes the structured shapes for `evidence`, `conflicts`, and `rejectedItems` rather than unknown arrays.

The result contains both a short text summary and structured `EvidenceBundle` content. Deduplication preserves distinct canonical source URLs. Numeric/date guards prevent materially different facts from being merged; conflicts remain separate and are linked through unresolved conflict groups.

Public source text is inert data. Instruction-looking claim/excerpt text has no permissions and is never executed.

## Conflict identity

Conflict detection uses a deterministic comparable-fact identity rather than category/date alone. For comparable claims the normalizer derives a metric/entity signature from `claimNormalized` after removing subject markers, numbers/date tokens, month names, negation tokens, and common grammatical scaffolding. The conflict fact key combines:

```text
subject + category + metric/entity signature + unit + claim-date bucket
```

V1 compares metric/entity signatures exactly after that normalization. It deliberately does not use semantic similarity, embeddings, or an LLM for conflict identity. This conservative rule prevents broad categories such as `audience_metric` from grouping different entities such as Twitch followers and Instagram followers merely because most surrounding words, units, and dates are similar.

`claimDate` has two deterministic roles:

- when a typed `value` exists, differing claim dates are treated as different snapshots and are not compared as the same numeric fact;
- when neither side has a typed value, differing `claimDate` values are treated as a disputed event date only when each normalized claim explicitly contains its own year, month, and day. Otherwise the dates remain separate snapshots and do not create a conflict merely because they differ.

A detected event-date disagreement uses the `event-date-disputed` bucket so both evidence records remain linked while retaining their original `claimDate` values.

## `maxEvidence` retention policy

`maxEvidence` is applied only after exact/near deduplication, deterministic quality scoring, and unresolved conflict detection have completed across the full retained candidate set.

Retention is deterministic:

1. Each unresolved conflict group is an atomic retention unit. All detected conflict groups are retained before non-conflicting singleton evidence.
2. `maxEvidence` is a target cap for ordinary retention, not permission to erase an unresolved contradiction. If preserving a complete conflict group requires more records than `maxEvidence`, the normalizer exceeds the requested cap rather than dropping the group or emitting only one side.
3. After all conflict members are retained, any remaining budget up to `maxEvidence` is filled with non-conflicting evidence ranked by `qualityScore` descending, then fingerprint ascending.
4. Final `evidence[]` and `conflicts[]` ordering is stable by fingerprint/group ID so identical input and normalizer version produce identical output.

This makes `qualityScore` a ranking hint while keeping detected contradictions visible downstream. `stats.retainedEvidence` reports the actual retained count, which may therefore be greater than `options.maxEvidence` only when required to preserve unresolved conflict groups.
