# Bright Creator Profile

Isolated Remotion composition for the bright creator-profile video style.

The smoke test renders five reusable scene types:

- Hero subject with floating badges
- Big claim text
- Vertical evidence frame
- Social post card
- Creator statistics

The project renders one job at a time and does not modify the existing ScamRadar
composition. The API is designed to run as an internal Docker service for n8n;
do not publish it directly to the internet.

Render a JSON project:

```sh
node scripts/render-project.mjs examples/sample-project.json data/output.mp4
```

Supported scene types currently include `hero`, `claim`, `vertical`, `source`,
`social`, and `stats`. `vertical` and `source` accept a `mediaUrl` pointing to an
image or video.

## Bright Evidence MCP

The repository also contains the read-only Bright Evidence MCP tool
`normalize_evidence`. For direct ChatGPT connectivity, the supported remote test
endpoint for this deployment is:

```text
https://video.lanadesign.tech/mcp
```

The MCP Docker service remains published only on host loopback and is expected
to sit behind an HTTPS reverse proxy. See `docs/mcp-remote.md` for the deployment,
health-check, ChatGPT tool-scan, and security notes. See `docs/mcp-evidence.md`
for the evidence-normalization contract.

## Bright Evidence internal plugin

`plugins/bright-evidence/` packages the existing MCP workflow as an **internal/private** plugin for this project. It bundles the `public-evidence` skill, while `.agents/plugins/marketplace.json` exposes it as the repository-local install source.

This package is not intended for the public Plugins Directory, commercial distribution, or a production launch. It therefore does not add public listing/legal/domain-verification routes or submission-review assets.

The account/workspace-specific MCP connection ID is intentionally not committed. Register `https://video.lanadesign.tech/mcp` in the available ChatGPT plugin/developer controls, then wire the generated technical connection ID locally for that installation. See `docs/bright-evidence-plugin-internal.md`.

## API security notes

- Set a long random `BRIGHT_API_TOKEN`; all job/status/download endpoints require
  `x-bright-api-key`.
- Keep the Docker Compose service on `expose`, not public `ports`, unless you add
  a proper reverse proxy authentication layer.
- Private/localhost media URLs are blocked by default to reduce SSRF risk. Only
  set `ALLOW_PRIVATE_MEDIA_URLS=true` if the caller and source network are both
  trusted.
- Generated videos, QA frames, `.env`, and local data are ignored by Git.
