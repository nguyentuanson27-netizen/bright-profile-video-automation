import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const severityNames = ['info', 'low', 'moderate', 'high', 'critical'];

export const parseStandaloneAudit = (reportText, auditStatus) => {
  const errors = [];
  let report;

  try {
    report = JSON.parse(reportText);
  } catch (error) {
    return {ok: false, errors: [`unable to parse JSON (${error.message})`]};
  }

  if (!Number.isInteger(auditStatus) || ![0, 1].includes(auditStatus)) {
    errors.push(`unexpected npm audit status ${auditStatus}`);
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    errors.push('root must be an object');
    return {ok: false, errors};
  }
  if (report.auditReportVersion !== 2) errors.push('auditReportVersion must equal 2');
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) {
    errors.push('vulnerabilities must be an object');
    return {ok: false, errors};
  }

  const counts = report.metadata?.vulnerabilities;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    errors.push('metadata.vulnerabilities must be an object');
    return {ok: false, errors};
  }

  for (const name of [...severityNames, 'total']) {
    if (!Number.isInteger(counts[name]) || counts[name] < 0) {
      errors.push(`metadata.vulnerabilities.${name} must be a non-negative integer`);
    }
  }
  if (errors.some((message) => message.startsWith('metadata.vulnerabilities.'))) {
    return {ok: false, errors};
  }

  const total = severityNames.reduce((sum, name) => sum + counts[name], 0);
  if (counts.total !== total) errors.push('metadata vulnerability total is inconsistent');

  const observed = Object.fromEntries(severityNames.map((name) => [name, 0]));
  for (const [name, finding] of Object.entries(report.vulnerabilities)) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      errors.push(`${name} finding must be an object`);
      continue;
    }
    if (!severityNames.includes(finding.severity)) {
      errors.push(`${name} finding has invalid severity`);
      continue;
    }
    observed[finding.severity] += 1;
  }
  for (const name of severityNames) {
    if (observed[name] !== counts[name]) errors.push(`metadata vulnerability count for ${name} is inconsistent`);
  }

  const thresholdFindings = counts.high + counts.critical;
  if (auditStatus === 0 && thresholdFindings > 0) {
    errors.push('npm audit status 0 is inconsistent with high/critical findings');
  }
  if (auditStatus === 1 && thresholdFindings === 0) {
    errors.push('npm audit status 1 has no high/critical findings');
  }
  if (thresholdFindings > 0) {
    errors.push(`standalone production graph contains ${thresholdFindings} high/critical finding(s)`);
  }

  return {ok: errors.length === 0, errors};
};

export const runStandaloneAudit = ({spawn = spawnSync} = {}) => {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const audit = spawn(
    npmCommand,
    ['audit', '--omit=dev', '--audit-level=high', '--json'],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32'},
  );

  if (audit.error) {
    console.error(`Unable to execute standalone production audit: ${audit.error.message}`);
    return 1;
  }
  if (audit.stderr) process.stderr.write(audit.stderr);
  if (audit.stdout) process.stdout.write(audit.stdout);

  const result = parseStandaloneAudit(audit.stdout ?? '', audit.status ?? 2);
  if (!result.ok) {
    console.error('Standalone production dependency audit failed closed:');
    for (const error of result.errors) console.error(`- ${error}`);
    return 1;
  }
  return 0;
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = runStandaloneAudit();
