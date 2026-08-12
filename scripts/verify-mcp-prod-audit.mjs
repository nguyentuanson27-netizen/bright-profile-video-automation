import {readFileSync} from 'node:fs';

const reportPath = process.argv[2];
const auditStatusText = process.argv[3];
if (!reportPath || auditStatusText === undefined) {
  throw new Error('usage: node scripts/verify-mcp-prod-audit.mjs <npm-audit.json> <audit-status>');
}

const fail = (message) => {
  console.error(`Invalid production dependency audit report: ${message}`);
  process.exit(1);
};

const normalizeId = (value) => String(value).toUpperCase();
let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  fail(`unable to parse JSON (${error.message})`);
}

const auditStatus = Number(auditStatusText);
if (!Number.isInteger(auditStatus) || auditStatus < 0) fail('npm audit status must be a non-negative integer');
if (![0, 1].includes(auditStatus)) fail(`unexpected npm audit status ${auditStatus}`);
if (!report || typeof report !== 'object' || Array.isArray(report)) fail('root must be an object');
if (report.auditReportVersion !== 2) fail('auditReportVersion must equal 2');
if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) {
  fail('vulnerabilities must be an object');
}

const metadataCounts = report.metadata?.vulnerabilities;
if (!metadataCounts || typeof metadataCounts !== 'object' || Array.isArray(metadataCounts)) {
  fail('metadata.vulnerabilities must be an object');
}

const severityNames = ['info', 'low', 'moderate', 'high', 'critical'];
for (const name of [...severityNames, 'total']) {
  const value = metadataCounts[name];
  if (!Number.isInteger(value) || value < 0) fail(`metadata.vulnerabilities.${name} must be a non-negative integer`);
}
const metadataTotal = severityNames.reduce((sum, name) => sum + metadataCounts[name], 0);
if (metadataCounts.total !== metadataTotal) fail('metadata vulnerability total is inconsistent');

const observedCounts = Object.fromEntries(severityNames.map((name) => [name, 0]));
for (const [name, finding] of Object.entries(report.vulnerabilities)) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) fail(`${name} finding must be an object`);
  if (!severityNames.includes(finding.severity)) fail(`${name} finding has invalid severity`);
  observedCounts[finding.severity] += 1;
}
for (const name of severityNames) {
  if (observedCounts[name] !== metadataCounts[name]) {
    fail(`metadata vulnerability count for ${name} is inconsistent`);
  }
}

const thresholdFindings = metadataCounts.high + metadataCounts.critical;
if (auditStatus === 0 && thresholdFindings > 0) fail('npm audit status 0 is inconsistent with high/critical findings');
if (auditStatus === 1 && thresholdFindings === 0) fail('npm audit status 1 has no high/critical findings to triage');

const expected = new Map([
  ['brace-expansion', new Set(['GHSA-3JXR-9VMJ-R5CP', 'GHSA-MH99-V99M-4GVG', 'GHSA-RGW5-RVV9-X895'])],
  ['fast-uri', new Set(['GHSA-V2HH-GCRM-F6HX', 'GHSA-7P8R-X3MC-P8W7'])],
  ['nanoid', new Set(['GHSA-28WG-GHJ8-5HJV', 'GHSA-2V37-7H3G-55P8'])],
  ['postcss', new Set(['GHSA-R28C-9Q8G-F849', 'GHSA-FXQJ-RQCC-2CMP'])],
]);

const advisoryId = (via) => {
  if (!via || typeof via !== 'object') return null;
  const url = String(via.url ?? '');
  const match = url.match(/GHSA-[\w-]+/i);
  return match ? normalizeId(match[0]) : null;
};

const untriaged = [];
const observed = new Map();
for (const [name, finding] of Object.entries(report.vulnerabilities)) {
  if (!['high', 'critical'].includes(finding.severity)) continue;
  const allowed = expected.get(name);
  const viaEntries = Array.isArray(finding.via) ? finding.via : [];
  const parsedIds = viaEntries.map(advisoryId);
  const ids = new Set(parsedIds.filter(Boolean));
  observed.set(name, ids);
  if (!allowed) {
    untriaged.push(`${name}: unreviewed ${finding.severity} finding`);
    continue;
  }
  if (viaEntries.length === 0 || parsedIds.some((id) => !id)) {
    untriaged.push(`${name}: ${finding.severity} finding has no complete parseable advisory identity`);
  }
  for (const id of ids) {
    if (!allowed.has(id)) untriaged.push(`${name}: unreviewed advisory ${id}`);
  }
}

for (const [name, allowed] of expected) {
  const ids = observed.get(name);
  if (!ids) continue;
  for (const id of ids) {
    if (!allowed.has(id)) untriaged.push(`${name}: advisory mismatch ${id}`);
  }
}

if (metadataCounts.critical > 0) untriaged.push(`${metadataCounts.critical} critical vulnerability finding(s)`);

if (untriaged.length) {
  console.error('Untriaged production dependency audit findings:');
  for (const item of untriaged) console.error(`- ${item}`);
  process.exit(1);
}

const highNames = [...observed.keys()].sort();
if (highNames.length) {
  console.log(`Reviewed production audit findings: ${highNames.join(', ')}`);
  console.log('Reachability/risk acceptance: docs/security/mcp-dependency-audit.md');
} else {
  console.log('No high/critical production dependency findings.');
}
