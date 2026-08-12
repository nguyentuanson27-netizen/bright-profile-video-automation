# Plan: Bright Evidence Internal Plugin

## Goal

Turn the existing Bright Evidence MCP + research skill into a minimal internal plugin package without adding public-submission or commercial-production surface area.

## Steps

1. Add RED regression tests that define the corrected internal-only scope.
2. Restore MCP server/config/CI files to the existing remote-MCP behavior and remove public listing/legal/challenge routes.
3. Remove public submission fixtures and submission documentation.
4. Keep the `public-evidence` skill and replace the manifest with minimal internal metadata.
5. Add `.agents/plugins/marketplace.json` as the private repository install source.
6. Add concise internal setup documentation for registering the MCP connection and wiring its generated technical ID locally.
7. Run the full existing verification suite and review correctness/security/scope.

## Boundaries

No normalization-core refactor, no write tools, no new auth/database/UI, no public directory submission, no legal/listing pages, and no hard-coded account/workspace MCP connection ID.
