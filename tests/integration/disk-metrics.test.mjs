import test from 'node:test';
import assert from 'node:assert/strict';
import {createObservability} from '../../app/observability.mjs';

test('metrics expose scrape-time disk free capacity and guard state without labels', async () => {
  let calls = 0;
  const observability = createObservability({
    logger: () => {},
    diskStatus: async () => {
      calls += 1;
      return {
        totalBytes: 1000,
        freeBytes: 190,
        freePercent: 19,
        warning: true,
        blocked: true,
      };
    },
  });

  const metrics = await observability.metrics();
  assert.equal(calls, 1);
  assert.match(metrics, /bright_disk_free_bytes 190/);
  assert.match(metrics, /bright_disk_free_ratio 0\.19/);
  assert.match(metrics, /bright_disk_warning 1/);
  assert.match(metrics, /bright_disk_blocked 1/);
  assert.equal(metrics.includes('{'), metrics.match(/bright_disk_(free_bytes|free_ratio|warning|blocked)\{/g) !== null ? false : true);
});
