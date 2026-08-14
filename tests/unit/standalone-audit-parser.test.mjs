import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStandaloneAudit} from '../../security/standalone-audit-policy.mjs';

const makeReport = (vulnerabilities = {}, countOverrides = {}) => {
  const counts = {info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0};
  for (const finding of Object.values(vulnerabilities)) {
    if (finding?.severity && finding.severity in counts) {
      counts[finding.severity] += 1;
      counts.total += 1;
    }
  }
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {vulnerabilities: {...counts, ...countOverrides}},
  });
};

const finding = (severity) => ({severity, via: []});

test('standalone audit parser accepts a clean structured report', () => {
  assert.deepEqual(parseStandaloneAudit(makeReport(), 0), {ok: true, errors: []});
});

test('standalone audit parser rejects malformed JSON', () => {
  const result = parseStandaloneAudit('{not-json', 0);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /parse json/i);
});

test('standalone audit parser rejects an unexpected process status', () => {
  const result = parseStandaloneAudit(makeReport(), 2);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /audit status/i);
});

test('standalone audit parser fails on a new high finding', () => {
  const result = parseStandaloneAudit(makeReport({'new-package': finding('high')}), 1);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /high\/critical/i);
});

test('standalone audit parser fails on a critical finding', () => {
  const result = parseStandaloneAudit(makeReport({'critical-package': finding('critical')}), 1);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /high\/critical/i);
});

test('standalone audit parser does not transfer MCP-reviewed high acceptance', () => {
  const result = parseStandaloneAudit(makeReport({'fast-uri': finding('high')}), 1);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /high\/critical/i);
});

test('standalone audit parser rejects inconsistent severity metadata', () => {
  const result = parseStandaloneAudit(makeReport({}, {total: 1}), 0);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /total is inconsistent/i);
});

test('standalone audit parser rejects status 1 without high or critical findings', () => {
  const result = parseStandaloneAudit(makeReport(), 1);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /status 1/i);
});
