# Bright Creator Profile

Internal creator-profile video automation built around a standalone Node/SQLite app, durable worker stages, React/Vite review UI, Remotion, Google Cloud TTS, and the Bright Evidence MCP integration for ChatGPT.

## Standalone internal MVP

The retained operator flow is implemented as:

```text
create
  -> research
  -> generate
  -> review/edit
  -> approve
  -> render-start
  -> media ingest
  -> TTS
  -> render
  -> download MP4
```

The app owns project/revision/source/stage state in SQLite. Remote work runs only in the durable worker, which uses leases, claim fencing, bounded retry, cancel/reclaim handling, and application-owned artifact paths. Approved revisions are immutable; downstream media/TTS/render work stays bound to the same approved revision.

The generated draft is never auto-approved. Model-provided verification flags and override reasons are not trusted as human attestations. The UI exposes structured claim/script/voiceover/scene-copy editing and an explicit approval gate before downstream media work can begin.

## Run with Docker Compose

Copy the environment template and set only the provider credentials required by the flow you run. A ChatGPT MCP import that includes evidence and a structured draft does not require `OPENAI_API_KEY`; that key is only for the retained standalone research/generation flow.

```sh
cp .env.example .env
# edit .env

docker compose up -d --build
```

The main Compose stack contains exactly two services:

- `app`: serves the same-origin React UI and HTTP API; host publishing is loopback-only by default at `http://127.0.0.1:4180`;
- `worker`: runs research, generation, approved-media ingest, TTS, and render stages and publishes no HTTP port.

Both services share the named `/app/data` volume containing SQLite state and application-owned artifacts. The normal operator path does not require n8n or manually constructed project JSON.

For Google Cloud TTS, keep the local credential file outside Git at `.secrets/google-application-credentials.json` or set `GOOGLE_APPLICATION_CREDENTIALS_FILE` in `.env` to another host path. Compose mounts that file read-only into the worker at `/run/secrets/google-application-credentials.json`; the app service does not receive the credential mount.

## Local development

Install the frozen dependency graph and rebuild the pinned SQLite native module when needed:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm rebuild better-sqlite3 --no-audit --no-fund
```

Run the API on loopback:

```sh
node server.mjs
```

For frontend development, run Vite separately; `/api` and `/health` are proxied to the local API:

```sh
npm run dev:web
```

Build the frontend for same-origin serving from `dist/`:

```sh
npm run build:web
```

Run the durable worker in another process:

```sh
node worker.mjs
```

## Security boundaries

- The standalone Compose HTTP port is published on host loopback by default. Add an explicit trusted access boundary before exposing it remotely.
- Public-source/media fetching uses the SSRF-safe fetch path with DNS/IP validation, redirect revalidation, MIME limits, byte limits, and bounded timeouts.
- Remote filenames never choose local artifact paths. Media and output files live under application-owned attempt directories and are bound to the immutable approved revision with size/SHA-256 metadata.
- The normal Remotion path accepts only application-controlled local media references; arbitrary HTTP(S), `file:` and absolute/traversal references are rejected and Chromium web security is not disabled.
- The output endpoint has no caller-controlled filesystem/artifact selector. It serves only the authoritative MP4 for a completed current approved revision after path/size/hash validation.
- `.env`, local data, rendered videos, credential files, and QA artifacts must remain outside Git.

## Verification

The repository verification workflow covers frozen install, production dependency audit, SQLite migration smoke, unit/integration tests, aggregate lint, frontend build, syntax checks, standalone API/UI health, deterministic end-to-end pipeline coverage, Remotion smoke render, standalone app container/Compose boundaries, and the isolated MCP container boundary.

The deterministic full-flow regression uses fake research/generation/media/TTS/render adapters and no remote provider calls; live provider credentials are not required in normal CI.

## Render core

The lower-level render helper remains available for development/regression work:

```sh
node scripts/render-project.mjs examples/sample-project.json data/output.mp4
```

Supported scene types are `hero`, `claim`, `vertical`, `source`, `social`, and `stats`.

## Bright Evidence MCP for ChatGPT

The repository exposes the Bright Evidence MCP integration for ChatGPT research and video automation with 8 tools (`normalize_evidence`, `create_video_project`, `get_video_project`, `edit_video_draft`, `approve_video_project`, `start_video_render`, `retry_video_project`, `cancel_video_project`). ChatGPT can submit normalized evidence with an optional structured script draft; Bright stores supplied drafts at `review_required` and never auto-approves or auto-renders them. The MCP Docker service remains independently published on host loopback and sits behind an HTTPS reverse proxy when used remotely with temporary noauth access. See `docs/mcp-remote.md` and `docs/mcp-evidence.md` for that boundary and lifecycle contract.

The current project scope is direct internal ChatGPT use. Public plugin distribution, Codex packaging, commercial launch readiness, and public Plugins Directory submission are not current goals.

See `docs/project-status.md`, `docs/specs/chatgpt-mcp-e2e-video-handoff.md`, and `tasks/traceability.md` for the authoritative milestone scope and closure ledger.
