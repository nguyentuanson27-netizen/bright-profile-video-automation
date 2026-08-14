import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, stat, writeFile} from 'node:fs/promises';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createMediaIngestService} from '../../app/services/ingest-media.mjs';

const project = {id: 'project/../../unsafe', status: 'media_ingest', currentRevisionId: 'revision-1', approvedRevisionId: 'revision-1'};
const revision = {
  id: 'revision-1',
  projectId: project.id,
  approvedAt: '2026-08-14T00:00:00.000Z',
  payload: {
    scenes: [
      {id: 'scene-1', sourceIds: ['source-1']},
      {id: 'scene-2', sourceIds: ['source-1']},
    ],
  },
};
const sources = [{
  id: 'source-1',
  projectId: project.id,
  status: 'available',
  url: 'https://cdn.example.test/../../remote-name.png?token=ignored-for-path',
}];
const claim = {stageId: 'stage/../../unsafe', attemptId: 'attempt/../../unsafe', revisionId: 'revision-1'};

test('media ingest derives local paths only from app-owned attempt identity and deduplicates scene sources', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bright-ingest-'));
  const seen = [];
  const fetcher = {
    async fetchToFile(url, destination, options) {
      seen.push({url, destination, options});
      await mkdir(join(destination, '..'), {recursive: true});
      await writeFile(destination, Buffer.from('safe-image'));
      return {url, mimeType: 'image/png', bytes: 10, path: destination};
    },
  };
  const service = createMediaIngestService({
    fetcher,
    dataDir,
    fetchOptions: {timeoutMs: 1000, maxBytes: 1024, maxRedirects: 2},
  });
  const result = await service.ingest({project, revision, sources, claim});

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, sources[0].url);
  assert.equal(seen[0].destination.includes('..'), false);
  assert.equal(seen[0].destination.includes('remote-name'), false);
  assert.equal(seen[0].destination.startsWith(dataDir), true);
  assert.deepEqual(result.manifest.media.map((item) => item.sourceId), ['source-1']);
  assert.equal(result.manifest.scenes['scene-1'], 'source-1');
  assert.equal(result.manifest.scenes['scene-2'], 'source-1');
  assert.equal((await stat(result.manifestAbsolutePath)).isFile(), true);
});

test('unsupported media response and interrupted fetch fail closed and leave no authoritative-ready manifest', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bright-ingest-fail-'));
  const unsupported = createMediaIngestService({
    fetcher: {
      async fetchToFile(_url, destination) {
        await mkdir(join(destination, '..'), {recursive: true});
        await writeFile(destination, 'html');
        return {url: 'https://example.test/page', mimeType: 'text/html', bytes: 4, path: destination};
      },
    },
    dataDir,
    fetchOptions: {timeoutMs: 1000, maxBytes: 1024, maxRedirects: 2},
  });
  await assert.rejects(() => unsupported.ingest({project, revision, sources, claim}), (error) => error?.code === 'FETCH_UNSUPPORTED_MEDIA_TYPE');

  const interrupted = createMediaIngestService({
    fetcher: {async fetchToFile() { throw Object.assign(new Error('network gone'), {code: 'FETCH_NETWORK_ERROR'}); }},
    dataDir,
    fetchOptions: {timeoutMs: 1000, maxBytes: 1024, maxRedirects: 2},
  });
  await assert.rejects(() => interrupted.ingest({project, revision, sources, claim}), (error) => error?.code === 'FETCH_NETWORK_ERROR' && error.retryable === true);
});
