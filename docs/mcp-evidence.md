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
