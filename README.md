# Bright Creator Profile

Standalone internal app for turning a creator name or topic into a source-grounded creator-profile video.

The current pipeline is:

1. Create a project from a creator/topic plus optional public URLs and research instructions.
2. Queue public-source research in the durable SQLite worker.
3. Automatically chain successful research into structured script/scene generation.
4. Stop at `review_required` for human review and approval.
5. After approval, ingest remote media into trusted local artifacts, generate TTS, and render with Remotion.

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

The production web bundle is written to `dist/web`. Production static serving, ingress, and authentication are handled by the later deployment/operations tasks rather than the Vite development server.

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

## Rendering

Supported scene types are `hero`, `claim`, `vertical`, `source`, `social`, and `stats`.

Approved remote media is fetched through the SSRF-safe ingest boundary and persisted as application-owned artifacts before rendering. The normal production render path accepts only bundled `asset://` references and ingested `artifact://` references; a loopback-only allowlist server exposes those files to Chromium while browser web security remains enabled.

## Current operator API

The T14 foundation exposes persisted project read models for the UI:

- `POST /api/projects` creates a project and atomically queues research.
- `GET /api/projects` returns recent project/status summaries.
- `GET /api/projects/:id/status` returns the persisted status, latest durable job, and source counts.
- `GET /api/projects/:id/sources` returns normalized source records.

Generation continues automatically after successful research. Human review/edit/approve/render controls are implemented in the next UI workflow task.

## Security boundaries

- Keep the app internal; production ingress/authentication is not considered complete until the deployment tasks are finished.
- Do not expose the Vite development server publicly.
- Remote media and research URLs pass through the safe-fetch SSRF boundary; render jobs do not consume arbitrary remote URLs directly.
- Secrets and provider credentials belong in the deployment environment, never in the repository or generated artifacts.
- Generated videos, work files, `.env`, and local runtime data remain outside version control.
