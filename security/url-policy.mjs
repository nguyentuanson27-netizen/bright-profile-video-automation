import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {AppError} from '../domain/errors.mjs';

const stripBrackets = (value) => value.startsWith('[') && value.endsWith(']')
  ? value.slice(1, -1)
  : value;

const normalizeHostname = (value) => stripBrackets(String(value).toLowerCase().replace(/\.$/, ''));

const ipv4ToBigInt = (address) => {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((value, part) => (value << 8n) | BigInt(part), 0n);
};

const embeddedIpv4Groups = (token) => {
  const value = ipv4ToBigInt(token);
  if (value === null) return null;
  return [
    Number((value >> 16n) & 0xffffn).toString(16),
    Number(value & 0xffffn).toString(16),
  ];
};

const ipv6Groups = (section) => {
  if (!section) return [];
  const tokens = section.split(':');
  const result = [];
  for (const token of tokens) {
    if (token.includes('.')) {
      const embedded = embeddedIpv4Groups(token);
      if (!embedded) return null;
      result.push(...embedded);
    } else {
      result.push(token);
    }
  }
  return result;
};

const ipv6ToBigInt = (address) => {
  const normalized = stripBrackets(address.toLowerCase());
  const halves = normalized.split('::');
  if (halves.length > 2) return null;

  const left = ipv6Groups(halves[0]);
  const right = ipv6Groups(halves[1] || '');
  if (!left || !right) return null;

  const hasCompression = halves.length === 2;
  const missing = 8 - left.length - right.length;
  if ((hasCompression && missing < 1) || (!hasCompression && missing !== 0)) return null;

  const groups = hasCompression
    ? [...left, ...Array(missing).fill('0'), ...right]
    : left;
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(`0x${group}`);
  }
  return value;
};

const inPrefix = (value, base, prefix, bits) => {
  const shift = BigInt(bits - prefix);
  return (value >> shift) === (base >> shift);
};

const IPV4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, prefix]) => [ipv4ToBigInt(base), prefix]);

const IPV6_BLOCKS = [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96],
  ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:10::', 28],
  ['2001:20::', 28], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7],
  ['fe80::', 10], ['ff00::', 8],
].map(([base, prefix]) => [ipv6ToBigInt(base), prefix]);

export function isPublicIp(address) {
  const normalized = stripBrackets(String(address));
  if (normalized.includes('%')) return false;
  const family = isIP(normalized);

  if (family === 4) {
    const value = ipv4ToBigInt(normalized);
    return value !== null && !IPV4_BLOCKS.some(([base, prefix]) => inPrefix(value, base, prefix, 32));
  }
  if (family === 6) {
    const value = ipv6ToBigInt(normalized);
    return value !== null && !IPV6_BLOCKS.some(([base, prefix]) => inPrefix(value, base, prefix, 128));
  }
  return false;
}

const parseHttpUrl = (input) => {
  let url;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(String(input));
  } catch {
    throw new AppError('FETCH_URL_INVALID', 'Fetch URL is invalid', {status: 400});
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('FETCH_PROTOCOL_REJECTED', 'Only HTTP and HTTPS URLs are allowed', {status: 400});
  }
  if (url.username || url.password) {
    throw new AppError('FETCH_URL_CREDENTIALS_REJECTED', 'Credentials are not allowed in fetch URLs', {status: 400});
  }
  return url;
};

export async function resolvePublicTarget(input, {lookup = dnsLookup} = {}) {
  const url = parseHttpUrl(input);
  const hostname = normalizeHostname(url.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata.google.internal') {
    throw new AppError('SSRF_BLOCKED_ADDRESS', 'Target address is not publicly routable', {status: 403});
  }

  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!isPublicIp(hostname)) {
      throw new AppError('SSRF_BLOCKED_ADDRESS', 'Target address is not publicly routable', {status: 403});
    }
    return {url, address: hostname, family: literalFamily};
  }

  let records;
  try {
    records = await lookup(hostname, {all: true, order: 'verbatim'});
  } catch {
    throw new AppError('FETCH_DNS_FAILED', 'Target hostname could not be resolved', {status: 502, retryable: true});
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new AppError('FETCH_DNS_EMPTY', 'Target hostname resolved to no addresses', {status: 502, retryable: true});
  }

  const normalizedRecords = records.map((record) => {
    const address = stripBrackets(String(record?.address || ''));
    return {address, family: isIP(address)};
  });
  if (normalizedRecords.some((record) => !record.family)) {
    throw new AppError('FETCH_DNS_INVALID', 'Target hostname resolved to an invalid address', {status: 502});
  }
  if (normalizedRecords.some((record) => !isPublicIp(record.address))) {
    throw new AppError('SSRF_BLOCKED_ADDRESS', 'Target address is not publicly routable', {status: 403});
  }

  const selected = normalizedRecords[0];
  return {url, address: selected.address, family: selected.family};
}
