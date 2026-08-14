# Remote Bright Evidence MCP

This profile exposes Bright Evidence to ChatGPT as a remote MCP endpoint through an existing HTTPS reverse proxy while keeping the Node MCP process off the public interface.

## Endpoint

Production/test endpoint for this deployment:

```text
https://video.lanadesign.tech/mcp
```

Health endpoint:

```text
https://video.lanadesign.tech/health
```

`MCP_PUBLIC_URL` is the canonical externally reachable MCP URL. When configured, the server derives its hostname and adds that hostname to the existing Host/Origin allow boundary. The value must be an absolute HTTPS URL; non-HTTPS values fail server construction instead of silently weakening remote transport security.

## Docker / reverse-proxy topology

`compose.mcp.yml` intentionally keeps the container published only on host loopback:

```text
Internet / ChatGPT
        |
        | HTTPS
        v
https://video.lanadesign.tech/mcp
        |
        | reverse proxy on the same host
        v
http://127.0.0.1:4190/mcp
        |
        v
bright-evidence-mcp container
```

The container listens on `0.0.0.0:4190` only inside Docker so the loopback host port can reach it. Docker still publishes the service as `127.0.0.1:4190:4190`; do not change that mapping to a public host address just to make ChatGPT connectivity work.

Relevant environment:

```env
MCP_PUBLIC_URL=https://video.lanadesign.tech/mcp
MCP_ALLOWED_HOSTS=127.0.0.1,localhost
MCP_MAX_BODY_BYTES=2097152
MCP_RATE_LIMIT_PER_MINUTE=60
MCP_REQUEST_TIMEOUT_MS=10000
```

The hostname from `MCP_PUBLIC_URL` is added to the explicit `MCP_ALLOWED_HOSTS` set. Unknown Host or Origin hostnames continue to receive `403`.

## Deploy / smoke check

```sh
docker compose -f compose.mcp.yml up -d --build
curl -i https://video.lanadesign.tech/health
```

Expected health result is HTTP `200` with `{"ok":true}`.

Then create/test the custom ChatGPT app with this MCP endpoint:

```text
https://video.lanadesign.tech/mcp
```

Scan tools and confirm ChatGPT discovers the single read-only tool `normalize_evidence`.

## Security status

The remote profile preserves Host/Origin validation, request-size/deadline limits, rate limiting, request IDs, and loopback-only Docker host publishing. It does not add write-capable tools or broaden renderer/database/model permissions.

The MCP process currently does not implement its own authentication layer. A public unauthenticated endpoint is acceptable only for a tightly controlled live smoke test. Before treating this as a durable production endpoint, place an authentication mechanism compatible with ChatGPT MCP in front of or inside the service and re-run the live acceptance flow. Do not disable Host/Origin checks as a substitute for authentication.
