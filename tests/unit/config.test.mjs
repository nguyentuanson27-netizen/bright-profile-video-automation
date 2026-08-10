import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig} from '../../app/config.mjs';

test('loadConfig applies conservative defaults', () => {
  const config = loadConfig({});

  assert.equal(config.port, 4180);
  assert.equal(config.workerOpsPort, 4181);
  assert.equal(config.dataDir, '/app/data');
  assert.equal(config.maxBodyBytes, 10 * 1024 * 1024);
  assert.equal(config.allowPrivateMediaUrls, false);
  assert.equal(config.completedArtifactRetentionDays, 30);
  assert.equal(config.transientArtifactRetentionDays, 7);
  assert.equal(config.diskWarningFreePercent, 25);
  assert.equal(config.diskHardFreePercent, 15);
  assert.equal(config.diskHardFreeGiB, 20);
});

test('loadConfig accepts valid overrides', () => {
  const config = loadConfig({
    PORT: '5000',
    WORKER_OPS_PORT: '5001',
    DATA_DIR: '/srv/bright-profile',
    MAX_BODY_BYTES: '2048',
    ALLOW_PRIVATE_MEDIA_URLS: 'true',
    COMPLETED_ARTIFACT_RETENTION_DAYS: '45',
    TRANSIENT_ARTIFACT_RETENTION_DAYS: '10',
    DISK_WARNING_FREE_PERCENT: '30',
    DISK_HARD_FREE_PERCENT: '18',
    DISK_HARD_FREE_GIB: '24',
  });

  assert.equal(config.port, 5000);
  assert.equal(config.workerOpsPort, 5001);
  assert.equal(config.dataDir, '/srv/bright-profile');
  assert.equal(config.maxBodyBytes, 2048);
  assert.equal(config.allowPrivateMediaUrls, true);
  assert.equal(config.completedArtifactRetentionDays, 45);
  assert.equal(config.transientArtifactRetentionDays, 10);
  assert.equal(config.diskWarningFreePercent, 30);
  assert.equal(config.diskHardFreePercent, 18);
  assert.equal(config.diskHardFreeGiB, 24);
});

test('loadConfig rejects malformed numeric configuration without echoing the value', () => {
  for (const key of ['PORT', 'WORKER_OPS_PORT', 'COMPLETED_ARTIFACT_RETENTION_DAYS', 'DISK_HARD_FREE_GIB']) {
    assert.throws(
      () => loadConfig({[key]: 'secret-looking-value'}),
      (error) => error.name === 'ConfigError'
        && error.message.includes(key)
        && !error.message.includes('secret-looking-value'),
    );
  }
});

test('loadConfig rejects invalid disk threshold ordering', () => {
  assert.throws(
    () => loadConfig({DISK_WARNING_FREE_PERCENT: '10', DISK_HARD_FREE_PERCENT: '15'}),
    (error) => error.name === 'ConfigError' && /DISK_HARD_FREE_PERCENT/.test(error.message),
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
