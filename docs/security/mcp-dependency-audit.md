# MCP production dependency audit

The MCP production verification workflow runs `npm audit --omit=dev --audit-level=high --json` against the root production lock graph installed by `Dockerfile.mcp`, then validates the report and process status with `scripts/verify-mcp-prod-audit.mjs`.

## Current state

The current locked production graph has no active high/critical MCP dependency findings in CI. There is no MCP high/critical risk-acceptance allowlist.

Any high or critical finding now fails the MCP dependency gate regardless of package name, advisory identity, or whether that advisory had been reviewed in an earlier PR. A remediated advisory returning to the graph therefore requires a fresh fix/review rather than inheriting historical acceptance.

The previously reviewed findings for `brace-expansion`, `fast-uri`, `nanoid`, and `postcss` were temporary reachability acceptances for older locked versions. Those acceptances are retired and are not part of the active verifier policy.

## Gate behavior

The audit report and process status are treated as untrusted boundary data before severity policy is applied:

- the JSON root must be an npm audit v2 report with `auditReportVersion: 2`;
- `vulnerabilities` and `metadata.vulnerabilities` must be present objects;
- `info`, `low`, `moderate`, `high`, `critical`, and `total` metadata counts must be non-negative integers and internally consistent;
- observed finding severities must agree with the metadata counts;
- the raw `npm audit` process status must be an expected status (`0` for no high/critical threshold findings or `1` when npm reports threshold findings) and must agree with the report;
- parse errors, audit-error-style envelopes, missing metadata, malformed/inconsistent reports, or unexpected process statuses fail closed;
- any `high` or `critical` finding fails the gate with no package/advisory exception.

`--audit-level=high` defines npm's command failure threshold; the repository verifier independently validates the structured report/status and enforces the current zero-high/critical MCP policy.

This MCP-specific check remains separate from `npm run audit:standalone`. The standalone gate covers the broader app/worker root production graph and does not rely on MCP reachability decisions.
