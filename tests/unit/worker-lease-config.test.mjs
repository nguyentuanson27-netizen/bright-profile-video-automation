import test from 'node:test';
import assert from 'node:assert/strict';

import {loadConfig} from '../../app/config.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

test('worker lease config never admits a value whose default heartbeat cannot renew before expiry', () => {
  assert.throws(
    () => loadConfig({WORKER_LEASE_MS: '1'}),
    /WORKER_LEASE_MS/,
  );

  assert.doesNotThrow(() => createJobRunner({
    jobs: {claimNext() {}},
    workerId: 'worker-small-lease',
    handlers: {media_ingest: async () => {}},
    leaseMs: 2,
  }));
});
