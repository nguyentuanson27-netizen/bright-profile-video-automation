# MCP production dependency audit triage

Review context: PR #1 / review `4907856994`.

The production verification workflow runs `npm audit --omit=dev --audit-level=high --json` against the same root lock graph installed by `Dockerfile.mcp`. High/critical findings are then checked by `scripts/verify-mcp-prod-audit.mjs`. That verifier fails closed on any high/critical package or advisory not listed below; this file records the temporary reachability/risk acceptance for the currently known findings.

## Current reviewed findings

### `fast-uri` 3.1.3 — high

Advisories:

- `GHSA-v2hh-gcrm-f6hx`
- `GHSA-7p8r-x3mc-p8w7`

Dependency path: `ajv@8.20.0` depends on `fast-uri`. Ajv is part of the MCP runtime and compiles the two checked-in evidence JSON Schemas during module initialization.

Reachability assessment for this service: callers provide evidence data, not JSON Schemas or schema identifiers. The MCP never compiles caller-provided schemas, never follows external `$ref` URLs, and does not use evidence URLs as schema URIs. The vulnerable authority/host parsing behavior is therefore not reachable from the public evidence fields in the current design.

Risk acceptance: temporary for this PR while the fixed transitive release is picked up by the locked dependency graph. Any new advisory or any future support for caller-provided/external schemas invalidates this acceptance and must fail CI/re-review.

### `brace-expansion` 2.1.1 — high

Advisories:

- `GHSA-3jxr-9vmj-r5cp`
- `GHSA-mh99-v99m-4gvg`
- `GHSA-rgw5-rvv9-x895`

This package is part of the inherited root production dependency graph installed into the MCP image. The MCP runtime does not expose glob/brace pattern input and the service code does not invoke filesystem globbing, shell commands, or source-provided patterns.

Risk acceptance: temporary for the current private/loopback MCP image. A minimal MCP-specific production lockfile remains the preferred packaging follow-up because it would remove unrelated render dependencies from the image instead of carrying unreachable code.

### `nanoid` 3.3.15 — high

Advisories:

- `GHSA-28wg-ghj8-5hjv`
- `GHSA-2v37-7h3g-55p8`

This version is brought by the inherited PostCSS/render toolchain. Bright Evidence IDs use Node `crypto` SHA-256 via `deterministicId()`; the MCP code does not import or call `nanoid`, and callers cannot choose generator sizes.

Risk acceptance: temporary for this root-graph image; unreachable from the MCP request path as implemented.

### `postcss` 8.5.16 — high

Advisories:

- `GHSA-r28c-9q8g-f849`
- `GHSA-fxqj-rqcc-2cmp`

This package belongs to the inherited render/bundler graph. The MCP container copies only `lib/evidence` and `mcp` application code and never invokes the Remotion/bundler/CSS pipeline. Public evidence content is not parsed as CSS or source maps.

Risk acceptance: temporary for the current root-graph image; no MCP request path reaches PostCSS.

## Gate behavior

The allowlist is intentionally exact and narrow:

- any `critical` finding fails;
- any new high-severity package fails;
- any new GHSA under one of the reviewed packages fails;
- removing an advisory from npm's report does not require keeping it present;
- changing MCP behavior so a reviewed vulnerable code path becomes reachable requires removing the acceptance and fixing/upgrading before production readiness.

The audit evidence is a production-hardening gate, not proof that unrelated inherited dependencies are desirable. A later minimal MCP manifest/lockfile should preserve frozen installs and this fail-closed advisory verification.
