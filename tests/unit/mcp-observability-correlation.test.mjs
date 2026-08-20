import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {createAppServer} from '../../app/server.mjs';
import {createBrightHttpServer} from '../../mcp/server.mjs';
import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'bright-obs-test-'));

const readRpcBody = async (response) => {
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) return response.json();
  const text = await response.text();
  const payloads = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean);
  if (!payloads.length) throw new Error(`No JSON-RPC payload in response: ${text}`);
  return JSON.parse(payloads.at(-1));
};

const rpc = async (url, body, extraHeaders = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  return {response, body: await readRpcBody(response)};
};

test('Observability: MCP request ID and correlation ID propagate across hops with secrets redacted', async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, 'bright-obs-test.sqlite');
  const db = openDatabase(dbPath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db);
  const artifactStore = createArtifactStore(db);

  const mcpAuthToken = 'super-secret-mcp-auth-token-12345678';
  const serviceToken = 'super-secret-internal-service-token-87654321';

  const appServer = createAppServer({
    db,
    repos,
    jobs,
    artifactStore,
    dataDir: dir,
    integrationToken: serviceToken,
  });

  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const appPort = appServer.address().port;
  const appUrl = `http://127.0.0.1:${appPort}`;

  const mcpServer = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_AUTH_TOKEN: mcpAuthToken,
      BRIGHT_BACKEND_URL: appUrl,
      BRIGHT_INTEGRATION_TOKEN: serviceToken,
    },
  });

  mcpServer.listen(0, '127.0.0.1');
  await once(mcpServer, 'listening');
  const mcpPort = mcpServer.address().port;
  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;

  t.after(async () => {
    await new Promise((res) => mcpServer.close(res));
    await new Promise((res) => appServer.close(res));
    db.close();
  });

  // Intercept stderr logs
  const originalStderrWrite = process.stderr.write;
  const capturedLogs = [];
  process.stderr.write = (chunk, ...args) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const line of str.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          capturedLogs.push(JSON.parse(trimmed));
        } catch {}
      }
    }
    return originalStderrWrite.call(process.stderr, chunk, ...args);
  };

  try {
    const clientCorrelationId = 'client-corr-xyz-123';
    const initRes = await rpc(mcpUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'obs-test', version: '1.0.0'}},
    }, {
      authorization: `Bearer ${mcpAuthToken}`,
      'x-correlation-id': clientCorrelationId,
    });
    assert.equal(initRes.response.status, 200);

    const bundle = normalizeEvidence({
      researchedAt: '2026-08-20T00:00:00.000Z',
      subject: {name: 'Obs Test Creator'},
      items: [
        {
          url: 'https://example.com/obs',
          claim: 'Creator is verified',
          category: 'identity',
          value: 'Obs Test Creator',
          confidence: 'high',
        },
      ],
    });

    const createRes = await rpc(mcpUrl, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_video_project',
        arguments: {
          creator: 'Obs Test Creator',
          topic: 'Observability verification',
          evidenceBundle: bundle,
          idempotencyKey: 'obs-idemp-001',
        },
      },
    }, {
      authorization: `Bearer ${mcpAuthToken}`,
      'x-correlation-id': clientCorrelationId,
    });

    assert.equal(createRes.response.status, 200);
    const projectId = createRes.body.result.structuredContent.projectId;
    assert.ok(projectId);

    // Verify captured logs across all 3 hops
    const mcpReqLogs = capturedLogs.filter((l) => l.event === 'mcp.request' && l.path === '/mcp');
    const mcpToolLogs = capturedLogs.filter((l) => l.event === 'mcp.tool_call' && l.tool === 'create_video_project');
    const integrationReqLogs = capturedLogs.filter((l) => l.event === 'integration.request');

    assert.ok(mcpReqLogs.length >= 1, 'Should log mcp.request event');
    assert.ok(mcpToolLogs.length >= 1, 'Should log mcp.tool_call event');
    assert.ok(integrationReqLogs.length >= 1, 'Should log integration.request event');

    const reqLog = mcpReqLogs.find((l) => l.correlationId === clientCorrelationId);
    assert.ok(reqLog, 'mcp.request should record client correlationId');
    const toolLog = mcpToolLogs[0];
    const intLog = integrationReqLogs[0];

    assert.equal(toolLog.correlationId, clientCorrelationId, 'mcp.tool_call correlationId must equal incoming clientCorrelationId');
    assert.equal(intLog.correlationId, clientCorrelationId, 'integration.request correlationId must equal incoming clientCorrelationId');
    assert.equal(reqLog.correlationId, clientCorrelationId, 'mcp.request correlationId must equal incoming clientCorrelationId');
    assert.equal(toolLog.idempotencyKey, '[REDACTED]');
    assert.equal(intLog.path, '/api/integrations/chatgpt/projects/import');

    // Verify secrets are redacted across all logs
    const allLogText = JSON.stringify(capturedLogs);
    assert.ok(!allLogText.includes(mcpAuthToken), 'mcpAuthToken must not appear in any log');
    assert.ok(!allLogText.includes(serviceToken), 'serviceToken must not appear in any log');
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});
