# Plan — ChatGPT Research → MCP Normalize + Deduplicate Evidence

**Status:** Proposed; awaiting human approval before `/build`  
**Approved MCP spec:** `specs/001-chatgpt-mcp-evidence/spec.md` on `spec/mcp-public-research-evidence`  
**Implementation base:** `spec/standalone-production-app` at `b92e0b6973b4f22c93fa2e489fbe6e56107c3e31`  
**Planned implementation branch:** `build/mcp-public-research-evidence`

## 1. Planning decisions

### Base branch is intentionally the old spec branch

Per user direction, implementation starts from `spec/standalone-production-app`, not from `build/standalone-production-app`.

This is an intentional trade-off:

- the base contains the original Remotion/render API baseline and the standalone production spec;
- it does **not** contain the later durable SQLite worker, operator UI, Gemini provider layer, OAuth ingress, observability, CI, or production deployment work from `build/standalone-production-app`;
- therefore this MCP milestone must not assume any of those later modules exist;
- later integration of MCP evidence with the newer standalone app will require an explicit merge/rebase/integration milestone.

The MCP milestone stays narrow so this branch choice does not trigger a reimplementation of the standalone production app.

### V1 product scope

V1 implements one MCP tool: `normalize_evidence`.

It is:

- pure/read-only;
- deterministic for identical input + normalizer version;
- no durable database writes;
- no web fetching inside MCP;
- no model/API call inside MCP;
- no shell execution;
- no arbitrary filesystem access;
- independent from the existing render API.

ChatGPT performs public-source research and semantic extraction. Bright MCP performs deterministic validation, normalization, deduplication, conflict grouping, and scoring, then returns an `EvidenceBundle`.

### Spec lineage

The approved MCP spec currently lives on `spec/mcp-public-research-evidence`, while implementation starts from the older standalone spec branch. Before behavioral implementation, copy the approved MCP spec into the implementation branch without changing its approved requirements.

### Test/tooling baseline

The selected base currently has only `render:smoke` and `render:project` scripts and no test/lint/MCP dependencies. The first implementation slice must establish the minimum test/lint/dependency foundation needed for safe incremental work rather than relying on tooling from the newer standalone build branch.

### MCP SDK and transport

At `/build` start, verify the current official OpenAI and Model Context Protocol documentation before choosing/pinning SDK APIs because MCP transport and ChatGPT app behavior are version-sensitive.

Target shape remains:

- official MCP SDK;
- stateless Streamable HTTP where supported by the verified SDK/docs;
- a separate `mcp/server.mjs` process;
- no import dependency from existing `server.mjs` into MCP;
- private/internal deployment first, preferably through the supported Secure MCP Tunnel path rather than a new public ingress.

### Deployment isolation

Do not retrofit the legacy `compose.yml` n8n network as the MCP transport. Add an isolated MCP deployment artifact such as `compose.mcp.yml` so the MCP service has no n8n runtime dependency.

### Renderer compatibility

Because the old spec branch is the base, the regression contract is the existing render/API baseline on that branch:

- existing render scripts remain functional;
- existing `server.mjs` behavior is not rewritten for MCP;
- MCP absence must not affect rendering;
- MCP code must not import Remotion/Google TTS unless a concrete boundary requires it, which is not expected in v1.

## 2. Dependency graph

```text
old standalone spec branch base
          |
          v
T00 copy approved MCP spec into lineage
          |
          v
T01 test/lint/dependency foundation
          |
          v
T02 schemas + validation
          |
          v
T03 normalization primitives
          |
          v
T04 fingerprints + exact dedupe
          |
          +-------------------+
          v                   v
T05 near-dedupe          T06 conflicts + scoring
          \                   /
           \                 /
            v               v
              T07 EvidenceBundle
                     |
                     v
              T08 MCP tool/server
                     |
                     v
              T09 hardening/limits
                     |
                     v
              T10 isolated deployment
                     |
                     v
              T11 CI + regression
                     |
                     v
              T12 live ChatGPT acceptance
                     |
                     v
              T13 final review/ship gate
```

T05 and T06 may proceed in parallel after T04. All later tasks are sequential.

---

## Task T00 — Bring approved MCP spec into implementation lineage

**Description:** Start `build/mcp-public-research-evidence` from `spec/standalone-production-app` and copy the already-approved MCP spec into the branch so implementation and review can reference requirements without depending on another branch.

**Acceptance criteria:**
- [ ] Build branch merge-base is `spec/standalone-production-app` commit `b92e0b6...` or its descendant.
- [ ] `specs/001-chatgpt-mcp-evidence/spec.md` exists on the build branch with no semantic requirement changes.
- [ ] No source/render behavior changes in this task.

**Verification:**
- [ ] Compare branch/ref metadata against the base.
- [ ] Diff copied spec against the approved spec branch.

**Dependencies:** None

**Files likely touched:**
- `specs/001-chatgpt-mcp-evidence/spec.md`

**Estimated scope:** Small (1 file)

---

## Task T01 — Establish test, lint, and MCP dependency foundation

**Description:** Add only the tooling required to develop and verify deterministic evidence logic and MCP integration from this older baseline. Do not pull in the standalone app's SQLite/UI/provider dependencies.

**Acceptance criteria:**
- [ ] `npm test` runs Node's built-in test runner.
- [ ] `npm run lint` runs a pinned ESLint configuration.
- [ ] Official MCP SDK and JSON-schema validation dependency are pinned in `package.json`/lockfile after current official-doc verification.
- [ ] Existing `render:smoke` and `render:project` scripts remain present.
- [ ] Dependency provenance/install scripts are reviewed before accepting lockfile changes.

**Verification:**
- [ ] `npm ci`
- [ ] `npm test`
- [ ] `npm run lint`
- [ ] `npm run render:smoke` when Chromium/FFmpeg runtime is available; otherwise mark this smoke pending, not passed.

**Dependencies:** T00

**Files likely touched:**
- `package.json`
- `package-lock.json`
- `eslint.config.js`
- `tests/unit/tooling.test.mjs`

**Estimated scope:** Medium (4 files)

---

## Task T02 — Define Evidence input/output schemas and validator

**Description:** Encode the approved request envelope, candidate item, retained evidence, source, conflict and `EvidenceBundle` contracts. Separate envelope-fatal validation from safe item-level rejection.

**Acceptance criteria:**
- [ ] Valid approved examples pass.
- [ ] Limits are encoded: max 200 candidates, claim max 2000 chars, excerpt max 1500 chars, absolute HTTP(S) URL.
- [ ] Malformed envelope returns stable structured validation error.
- [ ] Safe item-level defects can become `rejectedItems[]` without crashing the whole transform.
- [ ] Unknown fields do not affect fingerprints.

**Verification:**
- [ ] RED → GREEN: `node --test tests/unit/evidence-schema.test.mjs`
- [ ] `npm run lint`

**Dependencies:** T01

**Files likely touched:**
- `mcp/schemas/evidence-input.schema.json`
- `mcp/schemas/evidence-bundle.schema.json`
- `lib/evidence/validate.mjs`
- `tests/unit/evidence-schema.test.mjs`

**Estimated scope:** Medium (4 files)

---

## Task T03 — Implement conservative URL/text/value normalization

**Description:** Add deterministic normalization primitives used only for comparison/fingerprinting. Preserve human-readable originals and never paraphrase with a model.

**Acceptance criteria:**
- [ ] URL canonicalization removes fragments/default ports/known tracking parameters and sorts query parameters without deleting resource-identity parameters.
- [ ] Text comparison uses Unicode NFKC, whitespace/punctuation normalization and canonical subject aliases while preserving meaningful digits/signs/units.
- [ ] Explicit forms such as `2.1M` and `2.1 million` normalize consistently.
- [ ] Ambiguous currency/date/value input is not guessed.
- [ ] Vietnamese/English fixtures for the same explicit fact can normalize compatible numeric/date forms without language-model semantics.

**Verification:**
- [ ] RED → GREEN: `node --test tests/unit/evidence-normalization.test.mjs`
- [ ] `npm run lint`

**Dependencies:** T02

**Files likely touched:**
- `lib/evidence/canonical-url.mjs`
- `lib/evidence/normalize-text.mjs`
- `lib/evidence/normalize-value.mjs`
- `tests/unit/evidence-normalization.test.mjs`

**Estimated scope:** Medium (4 files)

---

## Task T04 — Fingerprints and exact deduplication

**Description:** Build stable SHA-256 fingerprints from normalized evidence identity and merge only exact duplicates while preserving all distinct canonical sources.

**Acceptance criteria:**
- [ ] Fingerprint material follows the approved spec and is independent of unknown fields/source ordering.
- [ ] Same normalized claim + equivalent canonical URL deduplicates.
- [ ] Repeated identical input is idempotent.
- [ ] Distinct canonical URLs supporting the same exact fact are preserved in `sources[]`.
- [ ] Metadata merge is deterministic.

**Verification:**
- [ ] RED → GREEN: `node --test tests/unit/evidence-exact-dedupe.test.mjs`
- [ ] `npm run lint`

**Dependencies:** T03

**Files likely touched:**
- `lib/evidence/fingerprint.mjs`
- `lib/evidence/deduplicate.mjs`
- `tests/unit/evidence-exact-dedupe.test.mjs`

**Estimated scope:** Medium (3 files)

---

## Task T05 — Guarded deterministic near-deduplication

**Description:** Add blocking rules plus deterministic token-set similarity for paraphrase-like duplicates without embeddings or model calls.

**Acceptance criteria:**
- [ ] Candidate pairs require compatible subject/category/date/value context before similarity evaluation.
- [ ] Default near-duplicate threshold is configurable with the approved default.
- [ ] Explicitly different numeric values outside tolerance never merge.
- [ ] Materially different dates never merge.
- [ ] Positive vs negated claims never merge.
- [ ] Source similarity alone never causes a merge.

**Verification:**
- [ ] RED → GREEN: `node --test tests/unit/evidence-near-dedupe.test.mjs`
- [ ] `npm run lint`

**Dependencies:** T04

**Files likely touched:**
- `lib/evidence/similarity.mjs`
- `lib/evidence/deduplicate.mjs`
- `tests/unit/evidence-near-dedupe.test.mjs`

**Estimated scope:** Medium (3 files)

---

## Task T06 — Conflict grouping and deterministic quality/confidence

**Description:** Keep contradictory evidence separate, group comparable conflicts, and compute ranking/confidence hints without treating repetition as truth probability.

**Acceptance criteria:**
- [ ] Same comparable fact with incompatible values creates a conflict group instead of merging/deleting evidence.
- [ ] Conflict IDs/fact keys are deterministic for identical normalized input.
- [ ] `qualityScore` is deterministic and bounded 0–1.
- [ ] Confidence uses evidence structure/source relationships and is downgraded by unresolved material conflict.
- [ ] Syndicated repetitions do not inflate confidence as independent confirmations.

**Verification:**
- [ ] RED → GREEN: `node --test tests/unit/evidence-conflicts-score.test.mjs`
- [ ] `npm run lint`

**Dependencies:** T04

**Files likely touched:**
- `lib/evidence/conflicts.mjs`
- `lib/evidence/score-evidence.mjs`
- `tests/unit/evidence-conflicts-score.test.mjs`

**Estimated scope:** Medium (3 files)

---

### Checkpoint A — Deterministic evidence core

- [ ] T02–T06 focused tests pass.
- [ ] `npm test` passes.
- [ ] `npm run lint` passes.
- [ ] No network/model/database dependency is needed by evidence-core tests.

---

## Task T07 — Compose the versioned EvidenceBundle transform

**Description:** Create the deterministic application function that executes validation → normalization → exact/near dedupe → conflicts → scoring and returns the approved bundle/stats/rejections.

**Acceptance criteria:**
- [ ] Output includes `schemaVersion`, `normalizerVersion`, subject, researchedAt, stats, evidence, conflicts and rejectedItems.
- [ ] IDs and ordering are stable for identical semantic input where the spec requires determinism.
- [ ] Stats exactly reconcile accepted/merged/conflict/rejected counts.
- [ ] Required fixtures from the spec are represented.
- [ ] No network/model/storage side effect.

**Verification:**
- [ ] RED → GREEN: `node --test tests/unit/evidence-bundle.test.mjs`
- [ ] Re-run deterministic test twice against identical fixture.

**Dependencies:** T05, T06

**Files likely touched:**
- `lib/evidence/normalize-evidence.mjs`
- `tests/unit/evidence-bundle.test.mjs`
- `examples/evidence-input.json`
- `examples/evidence-bundle.json`

**Estimated scope:** Medium (4 files)

---

## Task T08 — Expose `normalize_evidence` through a separate MCP process

**Description:** Add a minimal MCP server that exposes exactly one pure/read-only tool and delegates to the deterministic transform. Keep MCP completely independent from the existing render HTTP server.

**Acceptance criteria:**
- [ ] Current official MCP/OpenAI docs are re-checked before coding transport APIs.
- [ ] Exactly one application tool is exposed: `normalize_evidence`.
- [ ] Tool annotations/description make read-only/pure behavior explicit where supported.
- [ ] Tool result contains machine-readable `EvidenceBundle` plus concise summary text.
- [ ] Existing `server.mjs` does not import MCP modules.
- [ ] No OpenAI/Gemini/Google TTS call occurs inside the MCP process.

**Verification:**
- [ ] RED → GREEN: `node --test tests/integration/mcp-normalize.test.mjs`
- [ ] MCP initialize/list-tools/call-tool integration path succeeds locally.
- [ ] Existing render API process still starts independently.

**Dependencies:** T07

**Files likely touched:**
- `mcp/server.mjs`
- `mcp/tools/normalize-evidence.mjs`
- `tests/integration/mcp-normalize.test.mjs`
- `package.json`

**Estimated scope:** Medium (4 files)

---

## Task T09 — Harden MCP input and runtime boundary

**Description:** Enforce v1 abuse bounds and safe logging around the remote tool boundary. Source/claim text remains inert data.

**Acceptance criteria:**
- [ ] 2 MB request cap, 200 candidate cap and 10-second processing budget are enforced at the appropriate boundary.
- [ ] Malformed/oversized calls return structured non-secret errors.
- [ ] Request IDs are logged; full excerpts/request bodies/auth headers are not logged.
- [ ] Rate limiting is bounded and configurable for internal use.
- [ ] Host/origin/DNS-rebinding protections follow verified MCP HTTP server guidance.
- [ ] Prompt-injection-looking text is normalized as inert content and cannot change tool permissions/behavior.
- [ ] No arbitrary URL fetch, file access, shell action or model call is introduced.

**Verification:**
- [ ] RED → GREEN: `node --test tests/integration/mcp-security.test.mjs`
- [ ] `npm run lint`

**Dependencies:** T08

**Files likely touched:**
- `mcp/server.mjs`
- `mcp/security.mjs`
- `tests/integration/mcp-security.test.mjs`

**Estimated scope:** Medium (3 files)

---

## Task T10 — Add isolated MCP container/deployment path

**Description:** Package MCP without adopting the legacy n8n Compose topology.

**Acceptance criteria:**
- [ ] MCP runtime starts independently from render API.
- [ ] MCP deployment has no n8n network dependency.
- [ ] MCP receives no Google TTS/provider credential because v1 does not need one.
- [ ] MCP mounts no render job/data directory unless a concrete runtime need is proven.
- [ ] If a tunnel client reaches a host port, it binds only to loopback/private interface per verified deployment guidance.
- [ ] Health/readiness probe exists.
- [ ] Rollback is stopping/removing MCP without touching renderer state.

**Verification:**
- [ ] `docker compose -f compose.mcp.yml config` or final equivalent.
- [ ] Container health probe succeeds.
- [ ] Inspect mounts/env/network to confirm isolation.

**Dependencies:** T09

**Files likely touched:**
- `Dockerfile`
- `compose.mcp.yml`
- `.env.example`
- `docs/mcp-deployment.md`

**Estimated scope:** Medium (4 files)

---

## Task T11 — Add focused CI and baseline regression gates

**Description:** Because the chosen base does not contain the newer standalone CI workflow, add focused MCP CI plus regression checks for the old render baseline. Do not recreate the entire standalone production CI stack.

**Acceptance criteria:**
- [ ] Frozen install runs before tests.
- [ ] Unit/integration MCP tests and lint run in CI.
- [ ] MCP container/config smoke runs where Docker is available.
- [ ] CI verifies no provider secret/data mount is required for MCP.
- [ ] Existing render smoke is included when CI runtime supports Chromium/FFmpeg.
- [ ] CI failure blocks the MCP branch verification result.

**Verification:**
- [ ] GitHub Actions run on `build/mcp-public-research-evidence` completes successfully after implementation.
- [ ] Locally available equivalent commands are recorded with actual outcomes.

**Dependencies:** T10

**Files likely touched:**
- `.github/workflows/mcp-evidence.yml`
- `package.json`
- `Dockerfile` only if CI exposes a packaging defect

**Estimated scope:** Medium (2–3 files)

---

### Checkpoint B — Repository/runtime verification

- [ ] `npm ci`
- [ ] `npm test`
- [ ] `npm run lint`
- [ ] `npm run render:smoke` where runtime dependencies are available
- [ ] MCP container/config checks pass
- [ ] GitHub Actions MCP workflow is green

---

## Task T12 — Real ChatGPT acceptance through supported MCP connection

**Description:** Verify the actual user flow: connect ChatGPT to the deployed/private MCP service and call `normalize_evidence` with representative public-source evidence.

**Acceptance criteria:**
- [ ] ChatGPT developer/custom-app setup discovers the MCP server and `normalize_evidence`.
- [ ] Normal chat can call the tool and receive structured `EvidenceBundle` output.
- [ ] Deep Research read/fetch-compatible usage is verified where target workspace supports it.
- [ ] A representative duplicate pair merges while conflicting numeric evidence remains separate.
- [ ] Repeating identical input under the same normalizer version produces semantically identical output.
- [ ] Final tool-schema changes are followed by app refresh/re-scan.
- [ ] No private conversation content/secrets are committed as smoke-test evidence.

**Verification:**
- [ ] Actual ChatGPT → MCP call observed.
- [ ] Tool result inspected against Spec AC-1 through AC-8.

**Dependencies:** T11

**Files likely touched:**
- `docs/mcp-deployment.md` only for verified setup/runbook corrections

**Estimated scope:** Small (0–1 file plus external verification)

---

## Task T13 — Final review and ship gate

**Description:** Perform correctness → security → architecture → simplicity → performance review and verify project Definition of Done before proposing merge/ship.

**Acceptance criteria:**
- [ ] Explicit verification evidence exists for Spec AC-1 through AC-10.
- [ ] Existing renderer/API baseline works without MCP.
- [ ] MCP contains no model call, web fetch, DB write, shell action, destructive tool or n8n dependency in v1.
- [ ] Security review covers untrusted evidence, protocol boundary, dependency supply chain, logging, rate limits and deployment exposure.
- [ ] Full applicable tests/lint/render/Docker/CI checks have actual recorded results.
- [ ] Final review verdict is **Approve** before ship.
- [ ] Project-wide Definition of Done is checked; unmet items are reported rather than waived silently.

**Verification:**
- [ ] `/review` evidence recorded.
- [ ] `/ship` only after the above gates pass.

**Dependencies:** T12

**Files likely touched:**
- docs/tests only for issues found during review; no speculative refactor

**Estimated scope:** Small unless review finds defects

---

## 3. Primary risks and mitigations

### Risk: chosen base omits newer standalone implementation
**Impact:** MCP work will not automatically contain the durable worker/UI/CI/security architecture already built elsewhere.  
**Mitigation:** keep MCP v1 isolated; do not reimplement standalone features; schedule explicit integration after MCP v1.

### Risk: branch divergence/integration conflicts later
**Impact:** later integration into `build/standalone-production-app` may conflict in `package.json`, lockfile, Dockerfile, env and CI.  
**Mitigation:** keep changes modular under `mcp/` + `lib/evidence/`, touch shared root files minimally, and document every shared-file change.

### Risk: deterministic near-dedupe merges distinct claims
**Mitigation:** strict blocking rules; numeric/date/negation protections; conflict preservation; fixtures for false-positive cases.

### Risk: MCP/ChatGPT transport APIs change
**Mitigation:** source-driven development against current official OpenAI/MCP docs at T01/T08/T10; pin exact dependency versions and lockfile.

### Risk: remote MCP becomes an unnecessary attack surface
**Mitigation:** private/tunnel-first deployment, narrow single tool, bounded request size/time/rate, no secrets/data mounts, no agentic side effects.

### Risk: evidence score is mistaken for truth probability
**Mitigation:** document score as deterministic ranking hint, preserve conflicts, and prevent syndicated repetition from inflating confidence.

## 4. Deferred work

- persistent EvidenceBundle database;
- importing EvidenceBundle into standalone SQLite/project state;
- replacing/deprecating Gemini research in the newer standalone branch;
- write-capable MCP actions;
- OpenAI API calls from MCP;
- embeddings/vector database;
- MCP web crawler/search engine;
- public plugin/app distribution;
- auto-publishing video;
- reimplementation of the standalone production app on this old base branch.

## 5. Plan readiness gate

The plan is ready for `/build` when:

- the old-spec-branch base trade-off is accepted;
- T00–T13 are the agreed implementation order;
- no task assumes files/features from `build/standalone-production-app`;
- each behavioral task has focused verification;
- real ChatGPT acceptance remains a mandatory gate, not an inferred capability.
