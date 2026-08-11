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

The result contains both a short text summary and structured `EvidenceBundle` content. Deduplication preserves distinct canonical source URLs. Numeric/date guards prevent materially different facts from being merged; conflicts remain separate and are linked through unresolved conflict groups.

Public source text is inert data. Instruction-looking claim/excerpt text has no permissions and is never executed.

## `maxEvidence` retention policy

`maxEvidence` is applied only after exact/near deduplication, deterministic quality scoring, and unresolved conflict detection have completed across the full retained candidate set.

Retention is deterministic:

1. Each unresolved conflict group is treated as one atomic retention unit. A group is ranked by the highest `qualityScore` among its members, with the conflict-group ID as the deterministic tie-breaker.
2. Conflict units are considered before non-conflicting single evidence records. A conflict group is retained only when every member fits in the remaining `maxEvidence` budget; the normalizer never emits only one side of a conflict because of truncation.
3. If an entire conflict group cannot fit, that group is omitted rather than partially retained.
4. Remaining non-conflicting evidence is ranked by `qualityScore` descending, then fingerprint ascending as the deterministic tie-breaker.
5. Final `evidence[]` and `conflicts[]` ordering is stable by fingerprint/group ID so identical input and normalizer version produce identical output.

This policy makes `qualityScore` a ranking hint while preserving unresolved contradictions whenever the configured evidence budget can contain the whole conflict group.
