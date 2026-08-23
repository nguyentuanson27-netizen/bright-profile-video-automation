# T28 Live ChatGPT Acceptance Runbook

**Purpose:** operational checklist for PR #18 live acceptance after T17-T27 automated verification.  
**Parent spec:** `docs/specs/chatgpt-mcp-e2e-video-handoff.md`  
**Registration amendment:** `docs/specs/t28-chatgpt-custom-app-registration.md`

## Gate 0 — Previous window is closed

Do not start a new acceptance window until the previous one is torn down.

- [ ] `MCP_NOAUTH_WRITE_ENABLED=false` is confirmed.
- [ ] Previous public MCP ingress is withdrawn/disabled.
- [ ] Previous endpoint is verified externally unreachable.
- [ ] Write-disable timestamp is recorded.
- [ ] Ingress-withdraw timestamp is recorded.

If any item is unknown, stop here.

## Gate 1 — Deploy exact candidate with writes off

- [ ] Record full git SHA.
- [ ] Record immutable image digest when available.
- [ ] Deploy that exact candidate.
- [ ] Keep `MCP_NOAUTH_WRITE_ENABLED=false`.
- [ ] Configure finite limits and record them:
  - [ ] `MCP_RATE_LIMIT_PER_MINUTE`
  - [ ] `MCP_MAX_INFLIGHT_WRITE_REQUESTS`
  - [ ] `BRIGHT_CHATGPT_MAX_ACTIVE_PROJECTS`
- [ ] Keep Bright Profile app/worker private.
- [ ] Open the bounded HTTPS MCP ingress for discovery/acceptance.
- [ ] Record ingress-enable timestamp.
- [ ] Verify `/health` is reachable from the intended external test path.

## Gate 2 — ChatGPT custom app registration and discovery

The live test must use a custom ChatGPT app pointing at the PR #18 MCP endpoint. Do not use the stale read-only `Bright Evidence` catalog for Path A/B.

Expected endpoint:

```text
https://video.lanadesign.tech/mcp
```

With writes still **OFF**:

- [ ] Create, reconnect, or refresh the Bright Profile Video custom app against the endpoint above.
- [ ] Trigger the client action/tool refresh mechanism (for example Scan Tools / Refresh Actions / equivalent UI).
- [ ] Record the app display name used for acceptance.
- [ ] Record the endpoint shown in its configuration if the UI exposes it.
- [ ] Verify the client exposes exactly the required lifecycle surface below.

Required tools:

- [ ] `normalize_evidence`
- [ ] `create_video_project`
- [ ] `get_video_project`
- [ ] `edit_video_draft`
- [ ] `approve_video_project`
- [ ] `start_video_render`
- [ ] `retry_video_project`
- [ ] `cancel_video_project`

For `create_video_project`, confirm the discovered input schema exposes the optional `draft` object. Although optional for API compatibility, it is mandatory in the T28 Path A call.

**Fail/blocked condition:** if only `normalize_evidence` is available, or any required lifecycle tool is missing, do not enable anonymous writes. Record the discovery mismatch and stop.

## Gate 3 — Open the write-enabled acceptance window

Only after Gate 2 passes:

- [ ] Set `MCP_NOAUTH_WRITE_ENABLED=true`.
- [ ] Record write-enable timestamp.
- [ ] Confirm the same finite rate/in-flight/active-project limits remain in force.
- [ ] Do not expose the private Bright Profile app directly.

## Path A — Stop at review

Use a fresh test project.

Required sequence:

1. ChatGPT performs public-source research.
2. ChatGPT calls `normalize_evidence`.
3. ChatGPT constructs a complete structured draft from the normalized evidence, with every present `sourceIds` reference using normalized evidence IDs.
4. ChatGPT calls `create_video_project` exactly once for the intended project and supplies both `evidenceBundle` and the complete `draft`.
5. ChatGPT polls with `get_video_project` until `review_required`.
6. Verify the project reached review directly without a backend generation stage/provider call.
7. ChatGPT presents the draft/evidence to the user.
8. ChatGPT stops and waits for a separate explicit confirmation message.

Evidence to record:

- [ ] `normalize_evidence` tool call/result.
- [ ] Complete structured draft was constructed using normalized evidence IDs.
- [ ] `create_video_project` tool call/result includes both `evidenceBundle` and `draft` (record a bounded/schema summary, not sensitive raw content).
- [ ] Project ID.
- [ ] Status transition to `review_required`.
- [ ] Backend generation stage/provider call observed: **NO**.
- [ ] Current revision ID.
- [ ] Current/expected payload hash where exposed.
- [ ] Draft/evidence presentation in ChatGPT.
- [ ] `approve_video_project` invoked before confirmation: **NO**.
- [ ] `start_video_render` invoked before confirmation: **NO**.
- [ ] Downstream media/TTS/render started before confirmation: **NO**, where observable.

If `draft` is omitted, the project enters the compatibility backend-generation path, or approval/render starts before explicit user confirmation, Path A fails. Do not add `OPENAI_API_KEY` to rescue that acceptance attempt; correct the ChatGPT handoff and rerun with a complete supplied draft.

## User checkpoint

At `review_required`, the human explicitly decides whether to continue.

- [ ] Explicit user confirmation/continue message is recorded.

No Path B write should be attributed to human confirmation before this checkpoint.

## Path B — Review-acknowledged completion

After explicit confirmation:

1. ChatGPT calls `approve_video_project` using the exact current revision/hash.
2. Verify durable approval is represented as external review acknowledgment.
3. ChatGPT calls `start_video_render`.
4. Poll with `get_video_project` until `completed` or a terminal failure.
5. Retrieve the signed authoritative MP4 URL.
6. Open/retrieve it through the intended public download path.
7. Verify the MP4 is playable.

Evidence to record:

- [ ] Explicit confirmation occurred before approval call.
- [ ] Actual `approve_video_project` call/result.
- [ ] Audit wording/meaning = external review acknowledgment.
- [ ] Any persisted `approval_mode='user_reviewed'` is labeled legacy compatibility only.
- [ ] Actual `start_video_render` call/result.
- [ ] Media ingest completion.
- [ ] TTS completion.
- [ ] Render completion.
- [ ] Project `completed` state.
- [ ] Signed final MP4 retrieval.
- [ ] Browser/user-visible playback succeeds.

## Mandatory teardown

Immediately after the bounded acceptance run, regardless of pass/fail:

- [ ] Restore `MCP_NOAUTH_WRITE_ENABLED=false`.
- [ ] Record write-disable timestamp.
- [ ] Withdraw/disable external HTTPS MCP ingress/reverse-proxy route.
- [ ] Record ingress-withdraw timestamp.
- [ ] Verify the MCP endpoint is no longer externally reachable.

Both write disable and ingress withdrawal are required. One is not a substitute for the other.

## Evidence package

Record without secrets:

- [ ] exact git SHA;
- [ ] immutable image digest when available;
- [ ] environment/deployment identifier;
- [ ] custom ChatGPT app display name;
- [ ] observed eight-tool discovery result;
- [ ] ingress/write enable timestamps;
- [ ] configured finite limits;
- [ ] project ID;
- [ ] relevant revision/hash;
- [ ] tool-call order and bounded result summaries;
- [ ] bounded evidence that the Path A create call supplied a complete draft;
- [ ] Path A stop-at-review evidence;
- [ ] explicit user confirmation evidence;
- [ ] Path B completion evidence;
- [ ] MP4 retrieval/playback evidence;
- [ ] write-disable and ingress-withdraw timestamps;
- [ ] external-unreachable teardown evidence;
- [ ] exact-head `Bright Profile Verification` result for the final merge candidate.

Never record `BRIGHT_INTEGRATION_TOKEN`, signed download token contents, authorization headers, cookies, private credentials, or raw secrets.

## Attempt #1 — 2026-08-22

Recorded classification:

```text
Result: BLOCKED BEFORE PROJECT CREATION
normalize_evidence: SUCCESS
create_video_project: NOT INVOKED — unavailable in client catalog
get_video_project: NOT INVOKED
approve_video_project: NOT INVOKED
start_video_render: NOT INVOKED
downstream media/TTS/render: NO OBSERVED WORK
review_required: NOT REACHED
root blocker: stale/read-only Bright Evidence ChatGPT app registration/tool catalog
```

This attempt is negative discovery evidence. It is not a Path A pass/fail and does not replace a successful eight-tool custom-app run.

## Closure

T28 is complete only when:

- [ ] Gate 0-3 conditions are satisfied for the final acceptance attempt;
- [ ] Path A passes;
- [ ] explicit user checkpoint is observed;
- [ ] Path B passes with playable authoritative MP4;
- [ ] mandatory teardown passes;
- [ ] exact-head CI is green;
- [ ] project-wide Definition of Done is checked;
- [ ] project status/traceability/PR body are updated from observed truth.
