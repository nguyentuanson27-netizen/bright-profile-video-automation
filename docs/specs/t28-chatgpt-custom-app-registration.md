# T28 Amendment: ChatGPT Custom App Registration and Tool-Discovery Gate

**Status:** Approved clarification for PR #18 live acceptance  
**Date:** 2026-08-22  
**Parent spec:** `docs/specs/chatgpt-mcp-e2e-video-handoff.md`  
**Applies to:** T28 live ChatGPT acceptance only

## Why this amendment exists

T17-T27 implement the Bright Profile remote MCP server and its eight-tool video lifecycle. T28 must validate that the **actual ChatGPT custom app used for acceptance is registered against that remote MCP endpoint and has refreshed/scanned the current tool catalog**.

The first live T28 attempt exposed a client-registration mismatch:

- `normalize_evidence` was available and succeeded;
- the ChatGPT-side app available in that session was `Bright Evidence`, described as a read-only evidence-normalization app;
- `create_video_project` and `get_video_project` were not exposed to the client;
- therefore no project could be created and Path A could not reach `review_required`;
- `approve_video_project` and `start_video_render` were not invoked and no downstream media/TTS/render work was observed.

This result is classified as **BLOCKED BEFORE PROJECT CREATION**, not as a pass or fail of the stop-at-review behavior.

The reference operating pattern is the existing `lana-carousel-mcp-standalone` integration: ChatGPT uses a custom app that points directly at a public HTTPS Streamable HTTP MCP endpoint, scans/refreshes the MCP tool catalog, and then invokes the discovered read/write tools. The web studio is supplementary UI, not a substitute for the MCP tool surface.

## Clarified T28 client architecture

```text
ChatGPT custom app
  |
  | current scanned/refreshed MCP tool catalog
  v
https://video.lanadesign.tech/mcp
  |-- normalize_evidence
  |-- create_video_project
  |-- get_video_project
  |-- edit_video_draft
  |-- approve_video_project
  |-- start_video_render
  |-- retry_video_project
  `-- cancel_video_project
       |
       | private service-authenticated hop
       | BRIGHT_INTEGRATION_TOKEN
       v
Bright Profile app / durable worker pipeline
```

For this temporary milestone the external MCP transport remains the approved `noauth` contract. This amendment does **not** reintroduce OAuth, DCR, delegated authorization, or authenticated-user provenance.

## New prerequisite: ChatGPT app registration/discovery gate

Before `MCP_NOAUTH_WRITE_ENABLED=true` may be enabled for a T28 live acceptance window, the operator must verify the ChatGPT custom app used for the run.

Required evidence:

1. The app is the Bright Profile Video app intended for PR #18, not the stale read-only `Bright Evidence` app.
2. Its MCP endpoint is the intended acceptance endpoint:

   ```text
   https://video.lanadesign.tech/mcp
   ```

3. The app is created/refreshed/scanned against the current deployed MCP server after any tool-schema change.
4. Client tool discovery exposes **all eight** required tools:

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

5. Discovery is performed while anonymous writes are still disabled.
6. If the client sees only `normalize_evidence`, an older/stale app catalog, or fewer than all eight tools, T28 is **BLOCKED** and the write-enabled acceptance window must not be opened.

The client UI wording may vary (for example Create App, Scan Tools, Refresh Actions, or equivalent). T28 acceptance depends on the observed eight-tool catalog, not on a specific UI label.

## Acceptance-window ordering

The safe order is now explicit:

```text
deploy exact HEAD/image
  -> expose bounded HTTPS MCP ingress with writes OFF
  -> create/refresh ChatGPT custom app
  -> verify all 8 tools are discoverable
  -> record app/discovery evidence
  -> enable MCP_NOAUTH_WRITE_ENABLED=true
  -> execute Path A
  -> explicit user confirmation
  -> execute Path B
  -> verify playable authoritative MP4
  -> restore MCP_NOAUTH_WRITE_ENABLED=false
  -> withdraw external MCP ingress
  -> verify endpoint externally unreachable
```

Do not enable anonymous writes merely to test whether ChatGPT can discover the tool catalog. Tool discovery is a prerequisite and must be proven first.

## Path A remains unchanged

After the discovery gate passes:

```text
ChatGPT
  -> normalize_evidence
  -> create_video_project exactly once
  -> get_video_project until review_required
  -> show draft/evidence
  -> STOP
```

Pass evidence must show that before a separate explicit user-confirmation message:

- `approve_video_project` was not invoked;
- `start_video_render` was not invoked;
- no downstream media/TTS/render work started, where observable.

This proves tested-client behavior only. It does not create a universal server-side human-authorization guarantee in `noauth` mode.

## Path B remains unchanged

Only after explicit user confirmation:

```text
approve_video_project
  -> external review acknowledgment
  -> start_video_render
  -> completed
  -> signed authoritative MP4
  -> browser retrieval/playback
```

The durable audit must continue to describe the action as external review acknowledgment. Any retained `approval_mode='user_reviewed'` storage value remains legacy compatibility data and is not authenticated-human proof.

## Attempt #1 evidence classification

The 2026-08-22 live attempt is retained as useful negative acceptance evidence:

- acceptance endpoint intended: `https://video.lanadesign.tech/mcp`;
- `normalize_evidence`: SUCCESS;
- `create_video_project`: NOT INVOKED — unavailable in client action catalog;
- `get_video_project`: NOT INVOKED;
- `approve_video_project`: NOT INVOKED;
- `start_video_render`: NOT INVOKED;
- downstream media/TTS/render: NO OBSERVED WORK;
- `review_required`: NOT REACHED;
- result: **BLOCKED — stale/read-only ChatGPT app registration/tool catalog**.

Attempt #1 does not satisfy Path A. It also does not justify a backend lifecycle change by itself because the deployed server implementation already defines the eight-tool surface.

## Safety requirement before attempt #2

Before opening a second live acceptance window, record teardown of the first window:

- `MCP_NOAUTH_WRITE_ENABLED=false` restored;
- previous external MCP ingress withdrawn/disabled;
- endpoint verified externally unreachable;
- write-disable timestamp recorded;
- ingress-withdraw timestamp recorded.

If those teardown facts are not observed, T28 remains operationally blocked and a second anonymous write window must not be opened.

## Success criteria added by this amendment

T28 may close only when all original T28 criteria **and** the following are true:

- the actual ChatGPT custom app used in the live test is identified in evidence;
- it points to the intended Bright Profile MCP acceptance endpoint;
- its refreshed/scanned catalog exposes all eight required tools before writes are enabled;
- stale/read-only app registration is not used as a substitute for the PR #18 MCP app;
- Path A and Path B are executed through that discovered tool surface;
- mandatory teardown is observed and recorded after the final acceptance window.

## Out of scope

This amendment does not:

- add or restore OAuth for PR #18;
- change the eight MCP tool schemas;
- change Bright Profile lifecycle semantics;
- weaken the noauth kill switch/capacity controls;
- treat a different MCP client as equivalent evidence for the required live ChatGPT acceptance;
- infer ChatGPT account/plan capabilities from documentation instead of observing the actual custom-app tool catalog used for T28.
