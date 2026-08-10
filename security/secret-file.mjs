import {readFileSync, statSync} from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_SECRET_BYTES = 64 * 1024;

export function loadSecretValue({
  env,
  valueKey,
  fileKey,
  errorFactory = (message) => new Error(message),
  maxBytes = DEFAULT_MAX_SECRET_BYTES,
}) {
  if (!env || typeof env !== 'object') throw new TypeError('secret env is required');
  if (typeof valueKey !== 'string' || !valueKey) throw new TypeError('secret valueKey is required');
  if (typeof fileKey !== 'string' || !fileKey) throw new TypeError('secret fileKey is required');
  if (typeof errorFactory !== 'function') throw new TypeError('secret errorFactory must be a function');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('secret maxBytes is invalid');

  const file = String(env[fileKey] || '').trim();
  if (file) {
    if (!path.isAbsolute(file)) throw errorFactory(`${fileKey} must be an absolute path`);
    let info;
    try {
      info = statSync(file);
    } catch {
      throw errorFactory(`${fileKey} must reference a readable regular file`);
    }
    if (!info.isFile()) throw errorFactory(`${fileKey} must reference a readable regular file`);
    if (info.size <= 0) throw errorFactory(`${fileKey} must not be empty`);
    if (info.size > maxBytes) throw errorFactory(`${fileKey} exceeds the maximum secret size`);

    let value;
    try {
      value = readFileSync(file, 'utf8').trim();
    } catch {
      throw errorFactory(`${fileKey} must reference a readable regular file`);
    }
    if (!value) throw errorFactory(`${fileKey} must not be empty`);
    return value;
  }

  return String(env[valueKey] || '').trim();
}
