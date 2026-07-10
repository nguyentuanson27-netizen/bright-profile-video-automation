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

## API security notes

- Set a long random `BRIGHT_API_TOKEN`; all job/status/download endpoints require
  `x-bright-api-key`.
- Keep the Docker Compose service on `expose`, not public `ports`, unless you add
  a proper reverse proxy authentication layer.
- Private/localhost media URLs are blocked by default to reduce SSRF risk. Only
  set `ALLOW_PRIVATE_MEDIA_URLS=true` if the caller and source network are both
  trusted.
- Generated videos, QA frames, `.env`, and local data are ignored by Git.
