import {readFileSync} from 'node:fs';

const reportPath = process.argv[2];
if (!reportPath) throw new Error('usage: node scripts/verify-mcp-prod-audit.mjs <npm-audit.json>');

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const expected = new Map([
  ['brace-expansion', new Set(['GHSA-3jxr-9vmj-r5cp', 'GHSA-mh99-v99m-4gvg', 'GHSA-rgw5-rvv9-x895'])],
  ['fast-uri', new Set(['GHSA-v2hh-gcrm-f6hx', 'GHSA-7p8r-x3mc-p8w7'])],
  ['nanoid', new Set(['GHSA-28wg-ghj8-5hjv', 'GHSA-2v37-7h3g-55p8'])],
  ['postcss', new Set(['GHSA-r28c-9q8g-f849', 'GHSA-fxqj-rqcc-2cmp'])],
]);

const advisoryId = (via) => {
  if (!via || typeof via !== 'object') return null;
  const url = String(via.url ?? '');
  const match = url.match(/GHSA-[\w-]+/i);
  return match?.[0]?.toUpperCase() ?? null;
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
