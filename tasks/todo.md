# Task List — ChatGPT Research → MCP Normalize + Deduplicate Evidence

Source: `tasks/plan.md` and approved MCP Spec 001 on `spec/mcp-public-research-evidence`.

Implementation base: `spec/standalone-production-app` at `b92e0b6973b4f22c93fa2e489fbe6e56107c3e31`.

Rules:
- use `build/mcp-public-research-evidence`, based from the old standalone spec branch;
- copy the approved MCP spec into the build branch before behavioral changes;
- use RED → GREEN → REFACTOR for changed behavior;
- keep MCP pure/read-only in v1;
- do not assume SQLite worker/UI/Gemini/CI files from `build/standalone-production-app` exist;
- do not reimplement the standalone production app in this milestone;
- keep existing render/API baseline independent from MCP.

## T00 — Bring approved MCP spec into implementation lineage
- [ ] Confirm build branch base is `spec/standalone-production-app` / `b92e0b6...`.
- [ ] Copy `specs/001-chatgpt-mcp-evidence/spec.md` from approved MCP spec branch.
- [ ] Diff copied spec and confirm no semantic changes.

## T01 — Test/lint/MCP dependency foundation
- [ ] Add `npm test` using `node --test`.
- [ ] Add pinned ESLint config and `npm run lint`.
- [ ] Verify current official MCP/OpenAI docs before pinning MCP SDK APIs/version.
- [ ] Add/pin JSON-schema validation dependency.
- [ ] Preserve `render:smoke` and `render:project` scripts.
- [ ] Verify `npm ci`, `npm test`, `npm run lint`.

## T02 — Evidence schemas + validation
- [ ] Add input/output schemas.
- [ ] Enforce 200 items, 2000-char claims, 1500-char excerpts and HTTP(S) URLs.
- [ ] Separate fatal envelope errors from safe item rejection.
- [ ] Test: `node --test tests/unit/evidence-schema.test.mjs`.

## T03 — URL/text/value normalization
- [ ] Canonicalize URLs conservatively.
- [ ] Normalize comparison text without paraphrasing.
- [ ] Normalize explicit numeric/date/unit forms without guessing ambiguity.
- [ ] Include Vietnamese/English explicit-fact fixtures.
- [ ] Test: `node --test tests/unit/evidence-normalization.test.mjs`.

## T04 — Fingerprints + exact dedupe
- [ ] Implement deterministic SHA-256 evidence fingerprint.
- [ ] Merge exact duplicates idempotently.
- [ ] Preserve all distinct canonical sources.
- [ ] Test: `node --test tests/unit/evidence-exact-dedupe.test.mjs`.

## T05 — Guarded near-dedupe
- [ ] Implement blocking rules and token-set similarity.
- [ ] Protect numeric/date/negation mismatches from merging.
- [ ] Keep threshold configurable with approved default.
- [ ] Test: `node --test tests/unit/evidence-near-dedupe.test.mjs`.

## T06 — Conflicts + quality/confidence
- [ ] Keep contradictory facts separate.
- [ ] Link comparable contradictions through deterministic conflict groups.
- [ ] Add deterministic quality score and confidence labels.
- [ ] Prevent syndicated repetition from inflating confidence.
- [ ] Test: `node --test tests/unit/evidence-conflicts-score.test.mjs`.

### Checkpoint A
- [ ] `npm test`.
- [ ] `npm run lint`.
- [ ] Evidence-core tests require no network/model/database/provider key.

## T07 — EvidenceBundle orchestrator
- [ ] Compose validation → normalization → dedupe → conflicts → scoring.
- [ ] Produce stable versions, IDs, stats and `rejectedItems`.
- [ ] Add approved example fixtures.
- [ ] Test deterministic repeated input.
- [ ] Test: `node --test tests/unit/evidence-bundle.test.mjs`.

## T08 — MCP server + `normalize_evidence`
- [ ] Re-check official MCP/OpenAI docs immediately before implementation.
- [ ] Add separate MCP process.
- [ ] Expose exactly one read-only/pure application tool.
- [ ] Return structured EvidenceBundle + concise summary.
- [ ] Keep existing `server.mjs` independent from MCP.
- [ ] Test: `node --test tests/integration/mcp-normalize.test.mjs`.

## T09 — MCP boundary hardening
- [ ] Enforce 2 MB request and 10-second processing bounds.
- [ ] Add configurable rate limiting/request IDs/redacted logs.
- [ ] Apply verified Host/Origin/DNS-rebinding protections.
- [ ] Treat prompt-injection-looking evidence as inert data.
- [ ] Prove no URL fetch/file/shell/model side effect exists.
- [ ] Test: `node --test tests/integration/mcp-security.test.mjs`.

## T10 — Isolated MCP deployment
- [ ] Add MCP deployment path separate from legacy n8n Compose topology.
- [ ] No n8n network dependency.
- [ ] No Google TTS/provider credential in MCP.
- [ ] No render data volume mounted in MCP unless proven necessary.
- [ ] Prefer loopback/private tunnel target rather than public port.
- [ ] Add health/readiness and rollback docs.
- [ ] Verify `docker compose -f compose.mcp.yml config` or final equivalent.

## T11 — Focused CI + baseline regression
- [ ] Add focused MCP workflow because old spec base lacks newer standalone CI.
- [ ] Run frozen install, tests and lint.
- [ ] Run MCP container/config smoke.
- [ ] Assert no provider secret/data mount for MCP.
- [ ] Run existing render smoke when CI runtime supports Chromium/FFmpeg.
- [ ] Require green GitHub Actions result.

### Checkpoint B
- [ ] `npm ci`.
- [ ] `npm test`.
- [ ] `npm run lint`.
- [ ] `npm run render:smoke` where supported.
- [ ] MCP container/config verification passes.
- [ ] GitHub Actions is green.

## T12 — Real ChatGPT acceptance
- [ ] ChatGPT discovers `normalize_evidence`.
- [ ] Normal chat calls it successfully.
- [ ] Deep Research read/fetch use verified where workspace supports it.
- [ ] Duplicate fixture merges correctly.
- [ ] Conflict fixture stays separate/grouped.
- [ ] Identical input gives semantically identical result.
- [ ] Re-scan app after final schema changes.
- [ ] Commit no secrets/private conversation content from smoke.

### Checkpoint C
- [ ] Actual ChatGPT → MCP call observed.
- [ ] Spec AC-1 through AC-8 inspected against real result.

## T13 — Final review / ship gate
- [ ] Evidence exists for Spec AC-1 through AC-10.
- [ ] Existing renderer/API baseline works with MCP absent.
- [ ] No model call, web fetch, DB write, shell action, destructive tool or n8n dependency in MCP v1.
- [ ] Security review passes.
- [ ] Applicable full tests/lint/render/Docker/CI checks actually pass.
- [ ] Code review verdict: Approve.
- [ ] Project Definition of Done checked before `/ship`.

## Deferred
- [ ] Persist EvidenceBundle into Bright DB.
- [ ] Integrate EvidenceBundle into newer standalone production branch.
- [ ] Replace/deprecate Gemini research.
- [ ] Add write-capable MCP tools.
- [ ] Add embeddings/vector database.
- [ ] Add MCP crawler/search engine.
- [ ] Public MCP/app distribution.
