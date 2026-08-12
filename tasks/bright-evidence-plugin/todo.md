# Bright Evidence Internal Plugin — Task List

- [x] **I01 RED scope test** — prove the public-submission implementation conflicts with the internal-only requirement.
- [x] **I02 Remove over-scope surface** — remove public listing/legal/support/domain-challenge behavior and config.
- [x] **I03 Internal package** — keep the public-evidence skill, minimize plugin metadata, and add the repo-local marketplace.
- [x] **I04 Internal setup docs** — document MCP registration and local connection-ID wiring without hard-coding it.
- [x] **I05 Verification/review** — full exact-head CI and focused correctness/security review.
- [x] **I06a Live MCP acceptance** — the actual ChatGPT app connection discovered `normalize_evidence` and an observed tool call returned a structured EvidenceBundle with 2 input items, 1 retained item, 1 exact duplicate removed, 0 conflicts, and 0 rejected items.
- [ ] **I06b Local plugin package acceptance** — copy the real `plugin_asdk_app...` connection ID into the git-ignored `plugins/bright-evidence/.app.json`, restart the ChatGPT desktop app, install Bright Evidence from the repo marketplace, and observe `normalize_evidence` being called from that installed plugin package.

## Definition of Done note

Remote MCP connectivity/tool invocation is verified. The repository plugin package is not fully accepted until I06b is exercised through the ChatGPT desktop repo-marketplace flow. There is no public publication or commercial launch gate in this scope.
