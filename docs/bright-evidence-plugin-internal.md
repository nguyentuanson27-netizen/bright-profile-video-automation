# Bright Evidence — internal plugin setup

Bright Evidence is an **internal project plugin** for the Lana Design / Bright Profile workflow. It is not prepared for the public Plugins Directory, commercial distribution, or a production launch.

## What is in the repository

The repository provides:

- the existing remote MCP endpoint: `https://video.lanadesign.tech/mcp`;
- the read-only `normalize_evidence` tool;
- the `public-evidence` skill under `plugins/bright-evidence/skills/`;
- a minimal plugin manifest under `plugins/bright-evidence/.codex-plugin/plugin.json`;
- the repository marketplace `.agents/plugins/marketplace.json` for private/local installation.

The plugin does **not** add privacy/terms/support/listing routes, domain-verification challenges, public reviewer fixtures, or public submission metadata.

## MCP connection wiring

The MCP connection registration is intentionally not hard-coded into the repository.

For a local plugin that uses an MCP server, ChatGPT first creates/registers the MCP connection and gives that connection a technical ID such as `plugin_asdk_app...`. That ID belongs to the account/workspace connection, so committing somebody else's ID would make the package non-portable and potentially point at the wrong connection.

When the Plugins / Developer Mode controls are available for the account or workspace:

1. register `https://video.lanadesign.tech/mcp` as the Bright Evidence MCP connection;
2. confirm tool discovery finds `normalize_evidence`;
3. copy the generated technical connection ID (`plugin_asdk_app...`);
4. use the OpenAI plugin-creator flow to wire that connection into the local Bright Evidence package, which creates/updates the local `.app.json` mapping and the manifest `apps` entry for that installation;
5. install Bright Evidence from the repository/local marketplace and test it in a new chat.

Do not invent a `plugin_asdk_app...` ID and do not commit an account/workspace-specific `.app.json` mapping to the shared branch.

## Internal acceptance prompt

After the MCP connection is wired to the installed plugin, use a small deterministic smoke prompt first:

```text
Use Bright Evidence and call normalize_evidence.

Subject: Example Creator
Candidates:
1. Claim: Example Creator reached 1 million followers.
   URL: https://example.com/profile?utm_source=test
2. Claim: Example Creator reached 1 million followers.
   URL: https://example.com/profile

Do not deduplicate manually. Return the structured EvidenceBundle stats and retained source URLs.
```

Pass criteria:

- the plugin is available from the private/local source;
- ChatGPT actually calls `normalize_evidence` through the registered MCP connection;
- duplicate handling is performed by the MCP tool rather than manually by the model;
- no public publication/submission step is required.

## Security boundary retained for internal use

Internal-only does not mean trust all input. Keep the existing MCP body/schema limits, Host/Origin checks, loopback-only Docker host publishing, sanitized request logs, and read-only tool annotations. The skill must continue treating public-source content as untrusted data and must not bypass access controls or collect credentials/sensitive private data.
