import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const script = new URL('../../scripts/verify-mcp-prod-audit.mjs', import.meta.url);

const runPolicy = (report, auditStatus = 0) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-audit-'));
  const path = join(dir, 'audit.json');
  writeFileSync(path, JSON.stringify(report));
  return spawnSync(process.execPath, [script.pathname, path, String(auditStatus)], {encoding: 'utf8'});
};

const report = (vulnerabilities, critical = 0) => {
  const counts = {info: 0, low: 0, moderate: 0, high: 0, critical, total: critical};
  for (const finding of Object.values(vulnerabilities)) {
    const severity = finding?.severity;
    if (severity in counts && severity !== 'total') {
      counts[severity] += 1;
      counts.total += 1;
    }
  }
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {vulnerabilities: counts},
  };
};

test('audit policy accepts only the explicitly reviewed high advisory set', () => {
  const result = runPolicy(report({
    'fast-uri': {
      severity: 'high',
      via: [{url: 'https://github.com/advisories/GHSA-v2hh-gcrm-f6hx'}],
    },
  }), 1);
  assert.equal(result.status, 0, result.stderr);
});

test('audit policy fails closed on a new high advisory', () => {
  const result = runPolicy(report({
    'fast-uri': {
      severity: 'high',
      via: [{url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc'}],
    },
  }), 1);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unreviewed advisory/i);
});

test('audit policy fails closed when a reviewed high package has no parseable advisory identity', () => {
  const result = runPolicy(report({
    'fast-uri': {
      severity: 'high',
      via: [],
    },
  }), 1);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /advisory identity/i);
});

test('audit policy always fails on critical findings', () => {
  const result = runPolicy(report({}, 1), 1);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /critical vulnerability/i);
});

test('audit policy fails closed on an empty report object', () => {
  const result = runPolicy({}, 1);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /audit report/i);
});

test('audit policy fails closed when vulnerability metadata is missing', () => {
  const result = runPolicy({auditReportVersion: 2, vulnerabilities: {}}, 0);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /metadata/i);
});

test('audit policy fails closed on an audit-error-style JSON envelope', () => {
  const result = runPolicy({error: {code: 'EAUDIT', summary: 'registry request failed'}}, 1);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /audit report/i);
});

test('audit policy rejects unexpected npm audit process status', () => {
  const result = runPolicy(report({}), 2);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /audit status/i);
});
