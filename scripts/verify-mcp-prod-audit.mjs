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

if (thresholdFindings > 0) {
  console.error('MCP production dependency audit blocked: high/critical findings are not accepted.');
  for (const [name, finding] of Object.entries(report.vulnerabilities)) {
    if (['high', 'critical'].includes(finding.severity)) {
      console.error(`- ${name}: ${finding.severity}`);
    }
  }
  process.exit(1);
}

console.log('No high/critical production dependency findings.');
