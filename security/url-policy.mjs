import {isIP} from 'node:net';
import {AppError, ErrorCodes} from '../domain/errors.mjs';

const blocked = (message = 'Outbound URL is blocked by public-network policy') => new AppError(
  ErrorCodes.FETCH_BLOCKED,
  message,
  {status: 400},
);

const normalizeHost = (hostname) => String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
const ipv4Number = (address) => address.split('.').reduce((value, octet) => (((value << 8) | Number(octet)) >>> 0), 0);
const inV4Cidr = (value, base, prefix) => {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((value & mask) >>> 0) === ((base & mask) >>> 0);
};
const blockedV4Ranges = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, prefix]) => [ipv4Number(base), prefix]);
const isPublicV4Number = (value) => !blockedV4Ranges.some(([base, prefix]) => inV4Cidr(value, base, prefix));

const parseIpv6Parts = (part) => {
  if (!part) return [];
  const values = [];
  for (const token of part.split(':')) {
    if (!token) return null;
    if (token.includes('.')) {
      if (isIP(token) !== 4) return null;
      const ipv4 = ipv4Number(token);
      values.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
    } else {
      if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
      values.push(Number.parseInt(token, 16));
    }
  }
  return values;
};

const ipv6Number = (address) => {
  const normalized = normalizeHost(address);
  if (normalized.includes('%')) return null;
  const doubleColon = normalized.indexOf('::');
  if (doubleColon !== -1 && doubleColon !== normalized.lastIndexOf('::')) return null;
  const left = parseIpv6Parts(doubleColon === -1 ? normalized : normalized.slice(0, doubleColon));
  const right = parseIpv6Parts(doubleColon === -1 ? '' : normalized.slice(doubleColon + 2));
  if (!left || !right) return null;
  const explicit = left.length + right.length;
  let parts;
  if (doubleColon === -1) {
    if (explicit !== 8) return null;
    parts = left;
  } else {
    const missing = 8 - explicit;
    if (missing < 1) return null;
    parts = [...left, ...Array(missing).fill(0), ...right];
  }
  return parts.reduce((value, part) => (value << 16n) | BigInt(part), 0n);
};

const inV6Cidr = (value, base, prefix) => {
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (base >> shift);
};
const v6Base = (address) => {
  const value = ipv6Number(address);
  if (value === null) throw new Error(`invalid static IPv6 range: ${address}`);
  return value;
};
const GLOBAL_UNICAST_V6 = [v6Base('2000::'), 3];
const blockedV6Ranges = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20],
].map(([base, prefix]) => [v6Base(base), prefix]);

export const isPublicIp = (address) => {
  const normalized = normalizeHost(address);
  const version = isIP(normalized);
  if (version === 4) return isPublicV4Number(ipv4Number(normalized));
  if (version !== 6) return false;
  const value = ipv6Number(normalized);
  if (value === null || !inV6Cidr(value, ...GLOBAL_UNICAST_V6)) return false;
  return !blockedV6Ranges.some(([base, prefix]) => inV6Cidr(value, base, prefix));
};

const blockedHostnames = new Set([
  'localhost',
  'metadata.google.internal',
  'instance-data.ec2.internal',
  'metadata.azure.internal',
]);

export const assertSafePublicUrl = (input) => {
  let url;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw blocked('Outbound URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw blocked('Only public HTTP(S) URLs are allowed');
  if (url.username || url.password) throw blocked('Credential-bearing URLs are not allowed');
  const hostname = normalizeHost(url.hostname);
  if (
    !hostname
    || blockedHostnames.has(hostname)
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
  ) {
    throw blocked('Local or metadata hostnames are not allowed');
  }
  if (isIP(hostname) && !isPublicIp(hostname)) throw blocked('Non-public IP targets are not allowed');
  url.hash = '';
  return url;
};

export const normalizedHostname = (url) => normalizeHost(url.hostname);
