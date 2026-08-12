# Bright Evidence Internal Plugin — Task List

- [x] **I01 RED scope test** — prove the public-submission implementation conflicts with the internal-only requirement.
- [x] **I02 Remove over-scope surface** — remove public listing/legal/support/domain-challenge behavior and config.
- [x] **I03 Internal package** — keep the public-evidence skill, minimize plugin metadata, and add the repo-local marketplace.
- [x] **I04 Internal setup docs** — document MCP registration and local connection-ID wiring without hard-coding it.
- [ ] **I05 Verification/review** — full exact-head CI and focused correctness/security review.
- [ ] **I06 Live internal acceptance** — register the MCP connection in the actual ChatGPT account/workspace, wire the generated ID locally, install the plugin, and observe `normalize_evidence` being called.

## Definition of Done note

Repository completion is not the same as live ChatGPT acceptance. I06 remains open until the internal account/workspace installation is actually exercised. There is no public publication or commercial launch gate in this scope.
