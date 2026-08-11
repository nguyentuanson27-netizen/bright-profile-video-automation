import {readFileSync} from 'node:fs';

const reportPath = process.argv[2];
if (!reportPath) throw new Error('usage: node scripts/verify-mcp-prod-audit.mjs <npm-audit.json>');

const normalizeId = (value) => String(value).toUpperCase();
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
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

const vulnerabilities = report.vulnerabilities ?? {};
const untriaged = [];
const observed = new Map();
for (const [name, finding] of Object.entries(vulnerabilities)) {
  if (!['high', 'critical'].includes(finding?.severity)) continue;
  const allowed = expected.get(name);
  const ids = new Set((finding.via ?? []).map(advisoryId).filter(Boolean));
  observed.set(name, ids);
  if (!allowed) {
    untriaged.push(`${name}: unreviewed ${finding.severity} finding`);
    continue;
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

const critical = Number(report.metadata?.vulnerabilities?.critical ?? 0);
if (critical > 0) untriaged.push(`${critical} critical vulnerability finding(s)`);

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
