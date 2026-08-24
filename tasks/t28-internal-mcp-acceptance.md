# T28 Internal MCP Acceptance Runbook

**Purpose:** live acceptance for PR #18 using an internal MCP client.
**Decision:** `docs/decisions/001-t28-internal-mcp-acceptance.md`
**Parent spec:** `docs/specs/chatgpt-mcp-e2e-video-handoff.md`

## Boundary

ChatGPT Plus is used to research and write the draft. It is not the MCP client and does not need a custom app, Developer Mode, tool scan, plugin, or public MCP endpoint.

```text
ChatGPT Plus
  -> operator copies bounded evidence/draft material
  -> authenticated SSH tunnel
  -> 127.0.0.1:4190/mcp
  -> internal MCP client
  -> Bright Profile
```

The operator must not receive `BRIGHT_INTEGRATION_TOKEN`; the MCP process retains that private service credential. The public `https://video.lanadesign.tech/mcp` route remains HTTP 404 for the entire run.

## Gate 0 — closed public boundary and exact candidate

- [ ] Record the exact git SHA and image digest when available.
- [ ] App, worker, and MCP container are healthy.
- [ ] `MCP_NOAUTH_WRITE_ENABLED=false` before the run.
- [ ] Public `/mcp` returns HTTP 404.
- [ ] Establish an authenticated SSH tunnel from the single operator workstation to `127.0.0.1:4190` on the server.
- [ ] Use a normal Streamable HTTP MCP client through that tunnel; do not expose the tunnel or the MCP port on a LAN/public interface.
- [ ] Call `initialize` and `tools/list` from that client and record the eight-tool result.

Required tools:

```text
normalize_evidence
create_video_project
get_video_project
edit_video_draft
approve_video_project
start_video_render
retry_video_project
cancel_video_project
```

## Gate 1 — ChatGPT material and provenance bridge

1. In ChatGPT Plus, ask for public-source research with URLs/citations and bounded factual evidence candidates.
2. The internal MCP client calls `normalize_evidence` with those candidates and records the resulting normalized `EvidenceBundle`.
3. Give ChatGPT the normalized evidence IDs plus the evidence summaries, then ask it to construct a complete structured draft.
4. Every present `sourceIds` entry in claims, script, voiceover chunks, and scenes must use normalized evidence IDs. Do not invent IDs and do not use persisted Bright Profile source IDs.
5. Keep the ChatGPT text and the internal MCP transcript separate in the evidence record; never record credentials or signed-download tokens.

## Gate 2 — bounded internal write window

Only after Gate 0 and Gate 1 pass:

- [ ] Set `MCP_NOAUTH_WRITE_ENABLED=true` only on the internal deployment.
- [ ] Record the write-enable timestamp and configured finite limits.
- [ ] Reconfirm public `/mcp` remains HTTP 404.
- [ ] Do not expose the app, worker, or MCP port publicly.

## Path A — supplied draft, then stop at review

The internal MCP client performs the following sequence exactly once for the intended project:

```text
normalize_evidence
  -> construct complete draft using normalized evidence IDs
  -> create_video_project({ evidenceBundle, draft, ... })
  -> get_video_project until review_required
  -> operator presents persisted draft/evidence to the user
  -> STOP
```

Evidence to record:

- [ ] ChatGPT research/evidence summary and `normalize_evidence` result.
- [ ] Complete draft provenance uses normalized evidence IDs.
- [ ] `create_video_project` result with a bounded input/schema summary showing both `evidenceBundle` and `draft`.
- [ ] Project ID, revision ID, expected payload hash, and transition to `review_required`.
- [ ] No backend generation stage/provider call occurred.
- [ ] `approve_video_project` and `start_video_render` were not called before user confirmation.
- [ ] Draft/evidence was presented to the user.

If draft is omitted, backend generation starts, or approval/render occurs before confirmation, Path A fails. Do not add `OPENAI_API_KEY` to rescue the run; correct the handoff and start a new project.

## User checkpoint

At `review_required`, the user must send a separate explicit confirmation to continue.

- [ ] Confirmation text/time is recorded before the approval tool call.

## Path B — review-acknowledged completion

After the checkpoint, the internal MCP client:

```text
approve_video_project(current revision + hash)
  -> external_review_acknowledged
  -> start_video_render
  -> get_video_project until completed
  -> retrieve signed authoritative MP4
  -> browser-visible playback
```

- [ ] Approval tool call/result is recorded after confirmation.
- [ ] Audit is described as external review acknowledgment, not authenticated human proof.
- [ ] Render completes and the project reaches `completed`.
- [ ] Signed authoritative MP4 is retrieved and plays in a browser.

## Mandatory teardown

Immediately after a pass or failure:

- [ ] Restore `MCP_NOAUTH_WRITE_ENABLED=false`.
- [ ] Record the write-disable timestamp.
- [ ] Confirm public `/mcp` remains HTTP 404; no temporary external route may be opened for this runbook.
- [ ] Close the SSH tunnel.
- [ ] Record the final exact-head CI result and update project status/traceability/PR body from observed facts.

## Closure

T28 closes only when Path A, the explicit user checkpoint, Path B with playable MP4, write-disable teardown, exact-head CI, and the project-wide Definition of Done are all recorded. ChatGPT Plus availability or a ChatGPT custom-app scan is not a gate.
