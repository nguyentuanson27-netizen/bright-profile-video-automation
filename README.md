# Bright Creator Profile

Internal creator-profile video automation project built around Remotion, Google TTS, and a read-only Bright Evidence MCP integration for ChatGPT.

## Current project status

The project is **not yet a complete standalone app**.

Implemented and verified today:

- Remotion creator-profile renderer and reusable scene types;
- Google Cloud TTS integration and MP4 render path;
- authenticated internal job/status/download API baseline;
- Bright Evidence MCP tool `normalize_evidence`;
- remote ChatGPT connectivity to `https://video.lanadesign.tech/mcp`;
- an observed live `normalize_evidence` call returning a structured `EvidenceBundle` and removing an exact duplicate as expected.

Still required for the standalone MVP:

- durable project/job state across process restarts;
- creator/topic research orchestration;
- structured generation of claims/script/scene plan;
- human review and approval workflow;
- approved-media ingest and durable worker stages;
- operator UI for the end-to-end workflow;
- removal of the remaining n8n-era orchestration assumptions from the application flow.

See `docs/project-status.md` for the authoritative scope/status summary and `docs/specs/standalone-internal-mvp-amendment.md` for the scope correction that supersedes production/commercial assumptions in the older standalone spec.

## Render core

Render a JSON project directly:

```sh
node scripts/render-project.mjs examples/sample-project.json data/output.mp4
```

Supported scene types currently include `hero`, `claim`, `vertical`, `source`, `social`, and `stats`. `vertical` and `source` accept a `mediaUrl` pointing to an image or video.

The render core remains the execution foundation while the standalone workflow is built around it.

## Bright Evidence MCP for ChatGPT

The repository contains the read-only Bright Evidence MCP tool `normalize_evidence`.

Current remote endpoint:

```text
https://video.lanadesign.tech/mcp
```

The MCP Docker service remains published only on host loopback and is expected to sit behind an HTTPS reverse proxy. See `docs/mcp-remote.md` for deployment/security notes and `docs/mcp-evidence.md` for the normalization contract.

The current project requirement is **direct internal ChatGPT use of this MCP workflow**. Public plugin distribution, Codex packaging, desktop repo-marketplace acceptance, commercial publication, and public Plugins Directory submission are not current project goals.

## API security notes

- Set a long random `BRIGHT_API_TOKEN`; all job/status/download endpoints require `x-bright-api-key`.
- Keep the Docker Compose service private unless an explicit trusted access boundary is added.
- Private/localhost media URLs are blocked by default to reduce SSRF risk. Only set `ALLOW_PRIVATE_MEDIA_URLS=true` when both caller and source network are trusted.
- Generated videos, QA frames, `.env`, and local data are ignored by Git.
