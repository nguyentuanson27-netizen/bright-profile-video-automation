import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const script = new URL('../../scripts/verify-mcp-prod-audit.mjs', import.meta.url);

const runPolicy = (report) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-audit-'));
  const path = join(dir, 'audit.json');
  writeFileSync(path, JSON.stringify(report));
  return spawnSync(process.execPath, [script.pathname, path], {encoding: 'utf8'});
};

const report = (vulnerabilities, critical = 0) => ({
  auditReportVersion: 2,
  vulnerabilities,
  metadata: {vulnerabilities: {critical}},
});

test('audit policy accepts only the explicitly reviewed high advisory set', () => {
  const result = runPolicy(report({
    'fast-uri': {
      severity: 'high',
      via: [{url: 'https://github.com/advisories/GHSA-v2hh-gcrm-f6hx'}],
    },
  }));
  assert.equal(result.status, 0, result.stderr);
});

test('audit policy fails closed on a new high advisory', () => {
  const result = runPolicy(report({
    'fast-uri': {
      severity: 'high',
      via: [{url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc'}],
    },
  }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unreviewed advisory/i);
});

test('audit policy always fails on critical findings', () => {
  const result = runPolicy(report({}, 1));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /critical vulnerability/i);
});
