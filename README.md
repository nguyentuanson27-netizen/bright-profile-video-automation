# Bright Creator Profile

Standalone internal app for turning a creator name or topic into a source-grounded creator-profile video.

The current pipeline is:

1. Create a project from a creator/topic plus optional public URLs and research instructions.
2. Queue public-source research in the durable SQLite worker.
3. Automatically chain successful research into structured script/scene generation with Gemini.
4. Stop at `review_required` for human review and approval.
5. After approval, ingest remote media into trusted local artifacts, generate Google TTS, and render with Remotion.
6. Validate and download the completed MP4 from the operator UI.

The app is designed for a single internal operator/team. Public web and social content is treated as untrusted input and stored with provenance before it can influence generation or rendering.

## Development

Install the pinned dependency tree:

```sh
npm ci --strict-allow-scripts=true --no-audit --no-fund
```

Use the required environment variables described in `.env.example`, then run the API and durable worker in separate terminals:

```sh
node server.mjs
```

```sh
node worker.mjs
```

Run the Vite operator UI locally:

```sh
npm run dev
```

The development UI binds to `127.0.0.1:5173` and proxies `/api` and `/health` to the local API on port `4180`.

Build the web assets:

```sh
npm run build
```

The production web bundle is written to `dist/web` and is served by the standalone Node app. Production ingress uses the host's shared Caddy edge through GitHub-authenticated `oauth2-proxy`; see `docs/operations/deployment.md`.

## Verification

Run the Node test suite and lint checks:

```sh
npm test
npm run lint
```

Some integration tests exercise the real media pipeline and require `ffmpeg`/`ffprobe`, matching the production container runtime.

Render the controlled Remotion smoke fixture:

```sh
npm run render:smoke
```

Render a project JSON directly when working on the renderer in isolation:

```sh
node scripts/render-project.mjs examples/sample-project.json data/output.mp4
```

## Providers

- Research and structured generation: Gemini via `@google/genai`, default model `gemini-3.5-flash-lite`.
- Research discovery uses Google Search grounding; discovered URLs are still fetched and normalized by the application's SSRF-safe source boundary before generation.
- Generation has no browsing tools and must pass the application's local schema/provenance validation before a review revision is persisted.
- Voice generation uses Google Cloud Text-to-Speech.

Provider credentials are worker-only in production and use file-backed Compose secrets. The app/API container does not receive Gemini or Google TTS credentials.

## Rendering

Supported scene types are `hero`, `claim`, `vertical`, `source`, `social`, and `stats`.

Approved remote media is fetched through the SSRF-safe ingest boundary and persisted as application-owned artifacts before rendering. The normal production render path accepts only bundled `asset://` references and ingested `artifact://` references; a loopback-only allowlist server exposes those files to Chromium while browser web security remains enabled.

## Operator API and review flow

- `POST /api/projects` creates a project and atomically queues research.
- `GET /api/projects` returns recent project/status summaries.
- `GET /api/projects/:id/status` returns persisted status, latest durable job, source counts, and latest revision summary.
- `GET /api/projects/:id/sources` returns normalized source records.
- Generation continues automatically after successful research.
- The operator UI exposes structured facts/sources, script, voiceover, and scene-plan editing.
- Approval produces an immutable approved revision; editing after approval creates a new draft and requires approval again.
- Render is allowed only from the approved revision, and completed video download revalidates the output artifact before serving it.

## Security boundaries

- Production public access must go through the shared Caddy → GitHub `oauth2-proxy` path; app and worker publish no host ports.
- Do not expose the Vite development server publicly.
- Remote media and research URLs pass through the safe-fetch SSRF boundary; render jobs do not consume arbitrary remote URLs directly.
- Research/model output is untrusted and must pass application validation; external content never becomes application instruction or authorization.
- Secrets and provider credentials use deployment-local secret files, never repository content, generated artifacts, browser storage, or client-side bundles.
- Generated videos, work files, `.env`, and local runtime data remain outside version control.
