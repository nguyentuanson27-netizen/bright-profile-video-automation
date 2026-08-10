import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig} from '../../app/config.mjs';

test('loadConfig applies conservative defaults', () => {
  const config = loadConfig({});

  assert.equal(config.port, 4180);
  assert.equal(config.dataDir, '/app/data');
  assert.equal(config.maxBodyBytes, 10 * 1024 * 1024);
  assert.equal(config.allowPrivateMediaUrls, false);
});

test('loadConfig accepts valid overrides', () => {
  const config = loadConfig({
    PORT: '5000',
    DATA_DIR: '/srv/bright-profile',
    MAX_BODY_BYTES: '2048',
    ALLOW_PRIVATE_MEDIA_URLS: 'true',
  });

  assert.equal(config.port, 5000);
  assert.equal(config.dataDir, '/srv/bright-profile');
  assert.equal(config.maxBodyBytes, 2048);
  assert.equal(config.allowPrivateMediaUrls, true);
});

test('loadConfig rejects malformed numeric configuration without echoing the value', () => {
  assert.throws(
    () => loadConfig({PORT: 'secret-looking-value'}),
    (error) => error.name === 'ConfigError'
      && /PORT/.test(error.message)
      && !/secret-looking-value/.test(error.message),
  );
});

test('loadConfig rejects malformed boolean configuration', () => {
  assert.throws(
    () => loadConfig({ALLOW_PRIVATE_MEDIA_URLS: 'yes'}),
    (error) => error.name === 'ConfigError' && /ALLOW_PRIVATE_MEDIA_URLS/.test(error.message),
  );
});

test('loadConfig requires an absolute data directory', () => {
  assert.throws(
    () => loadConfig({DATA_DIR: '../data'}),
    (error) => error.name === 'ConfigError' && /DATA_DIR/.test(error.message),
  );
});
