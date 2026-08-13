# Bright Evidence Internal ChatGPT Integration — Task List

- [x] **I01 RED scope test** — prove the earlier public-submission implementation conflicted with the internal-only requirement.
- [x] **I02 Remove over-scope surface** — remove public listing/legal/support/domain-challenge behavior and config.
- [x] **I03 Internal package baseline** — keep the public-evidence skill and minimal internal packaging without public-distribution surface.
- [x] **I04 Internal setup docs** — document the direct ChatGPT MCP workflow and security boundaries.
- [x] **I05 Verification/review** — full exact-head CI and focused correctness/security review.
- [x] **I06 Live ChatGPT MCP acceptance** — actual ChatGPT connection discovered `normalize_evidence` and an observed tool call returned a structured `EvidenceBundle` with 2 input items, 1 retained item, 1 exact duplicate removed, 0 conflicts, and 0 rejected items.

## Scope note

The current requirement ends at successful internal ChatGPT ↔ Bright Evidence MCP use. ChatGPT desktop repo-marketplace installation, Codex-specific packaging, public Plugins Directory publication, commercial launch, and public reviewer/legal flows are not required completion gates.

The account/workspace-specific `.app.json` remains git-ignored and must not be committed. Further plugin packaging work should only resume if the project scope changes explicitly.
