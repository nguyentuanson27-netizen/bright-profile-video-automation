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

## Bright Evidence OpenAI Plugin

The `plugins/bright-evidence/` package prepares the same read-only MCP capability
for an OpenAI Plugin submission under publisher **Lana Design**. It bundles a
`public-evidence` skill that researches public sources through ChatGPT's approved
web capabilities, preserves provenance, and delegates deterministic deduplication
and conflict handling to `normalize_evidence`.

Public listing/legal routes are served by the MCP HTTP process:

```text
https://video.lanadesign.tech/plugin
https://video.lanadesign.tech/privacy
https://video.lanadesign.tech/terms
https://video.lanadesign.tech/support
```

OpenAI domain verification is supported at
`/.well-known/openai-apps-challenge` after the portal-provided token is placed in
`OPENAI_APPS_CHALLENGE_TOKEN`. See `docs/plugin-submission.md` for the exact
submission, reverse-proxy, privacy/retention, Scan Tools, reviewer-test, and
human/platform gates. Repository completion alone does not mean the plugin has
been approved or published by OpenAI.

## API security notes

- Set a long random `BRIGHT_API_TOKEN`; all job/status/download endpoints require
  `x-bright-api-key`.
- Keep the Docker Compose service on `expose`, not public `ports`, unless you add
  a proper reverse proxy authentication layer.
- Private/localhost media URLs are blocked by default to reduce SSRF risk. Only
  set `ALLOW_PRIVATE_MEDIA_URLS=true` if the caller and source network are both
  trusted.
- Generated videos, QA frames, `.env`, and local data are ignored by Git.
