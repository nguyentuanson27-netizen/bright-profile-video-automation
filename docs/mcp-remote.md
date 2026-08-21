# Remote Bright Evidence MCP

This profile exposes Bright Evidence MCP to ChatGPT as a remote endpoint through an existing HTTPS reverse proxy while keeping the Node MCP process off the public interface.

## Endpoint

Production/test endpoint for this deployment:

```text
https://video.lanadesign.tech/mcp
```

Health endpoint:

```text
https://video.lanadesign.tech/health
```

`MCP_PUBLIC_URL` is the canonical externally reachable MCP URL (`https://video.lanadesign.tech/mcp`). When configured, the server derives its hostname and adds that hostname to the existing Host/Origin allow boundary. The value must be an absolute HTTPS URL; non-HTTPS values fail server construction instead of silently weakening remote transport security.

## Docker / Reverse-Proxy Topology

Compose keeps the containers bound to internal and loopback networks:

```text
Internet / ChatGPT / Browser
        |
        | HTTPS
        v
https://video.lanadesign.tech/mcp
https://video.lanadesign.tech/mcp/artifacts/:id/download?token=...
        |
        | reverse proxy on the same host
        v
http://127.0.0.1:4190/mcp (or /mcp/artifacts/...)
        |
        v
bright-evidence-mcp container
        |
        | private backend integration (http://app:4180)
        v
app container (SQLite, Projects, Stages, Artifacts)
```

The container listens on `0.0.0.0:4190` only inside Docker so the loopback host port can reach it. Docker publishes the service as `127.0.0.1:4190:4190`; do not change that mapping to a public host address.

Relevant environment:

```env
# Public MCP Reverse Proxy
MCP_PUBLIC_URL=https://video.lanadesign.tech/mcp
MCP_ALLOWED_HOSTS=127.0.0.1,localhost
MCP_MAX_BODY_BYTES=2097152
MCP_RATE_LIMIT_PER_MINUTE=20
MCP_REQUEST_TIMEOUT_MS=10000
MCP_NOAUTH_WRITE_ENABLED=false
MCP_MAX_INFLIGHT_WRITE_REQUESTS=2

# Private Backend Integration
BRIGHT_INTEGRATION_TOKEN=replace-with-internal-service-token
BRIGHT_BACKEND_URL=http://app:4180
BRIGHT_CHATGPT_MAX_ACTIVE_PROJECTS=3
```

## Available MCP Tools

When registered with ChatGPT, the server advertises 8 tools with root-level `securitySchemes: [{type: "noauth"}]`:

1. `normalize_evidence` — Deterministic evidence validation and deduplication (read-only).
2. `create_video_project` — Imports evidence bundle and queues project generation.
3. `get_video_project` — Queries current project status, draft, progress, and signed download URL.
4. `edit_video_draft` — Modifies structured draft claims, script, voiceover, and scenes during `review_required`.
5. `approve_video_project` — Explicit user review acknowledgment gate with payload hash attestation.
6. `start_video_render` — Transitions approved project into `media_ingest` -> `tts` -> `render` pipeline.
7. `retry_video_project` — Re-queues a retryable failed stage.
8. `cancel_video_project` — Cancels an active project.

## Download Reverse Proxy & Playback

When a video project reaches `completed` status, `get_video_project` returns a signed download URL:
`https://video.lanadesign.tech/mcp/artifacts/<artifactId>/download?token=<hmacToken>`

- The MCP server reverse proxies the download request to the backend `app` service after validating the token.
- Top-level browser navigation (`Sec-Fetch-Dest: document` / `video`, `Sec-Fetch-Mode: navigate`) is permitted on signed download routes to allow direct browser playback and downloading.
- Interactive browser document navigation to `/mcp` remains rejected (`403 HOST_NOT_ALLOWED`).

## Capacity & Safety Controls

- **Rate Limiting**: `MCP_RATE_LIMIT_PER_MINUTE=20` per client IP.
- **In-Flight Write Cap**: `MCP_MAX_INFLIGHT_WRITE_REQUESTS=2` limits concurrent mutation requests.
- **Active Project Admission Cap**: `BRIGHT_CHATGPT_MAX_ACTIVE_PROJECTS=3` (SQLite-enforced limit on concurrent active projects).
- **Kill-Switch**: Setting `MCP_NOAUTH_WRITE_ENABLED=false` immediately disables all mutation tools.

## Mandatory Teardown After Live Acceptance

The temporary public `noauth` write-capable profile is designed exclusively for milestone acceptance verification. Once verification is complete:
1. Set `MCP_NOAUTH_WRITE_ENABLED=false` in `.env` and restart containers.
2. Withdraw external ingress routing at the reverse proxy level (`https://video.lanadesign.tech/mcp`).
