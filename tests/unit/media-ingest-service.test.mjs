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
  url: 'https://news.example.test/profile/creator',
}];
const claim = {stageId: 'stage/../../unsafe', attemptId: 'attempt/../../unsafe', revisionId: 'revision-1'};

test('media ingest selects separate media from factual HTML provenance and persists an app-owned immutable selection', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bright-ingest-'));
  const seen = [];
  const selectedMediaUrl = 'https://cdn.example.test/remote-name.png?token=ignored-for-path';
  const fetcher = {
    async fetchToFile(url, destination, options) {
      seen.push({url, destination, options});
      await mkdir(join(destination, '..'), {recursive: true});
      if (url === sources[0].url) {
        const html = `<html><head><meta property="og:image" content="${selectedMediaUrl}"></head></html>`;
        await writeFile(destination, html);
        return {url, mimeType: 'text/html', bytes: Buffer.byteLength(html), path: destination};
      }
      assert.equal(url, selectedMediaUrl);
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

  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, sources[0].url);
  assert.equal(seen[1].url, selectedMediaUrl);
  assert.equal(seen[1].destination.includes('..'), false);
  assert.equal(seen[1].destination.includes('remote-name'), false);
  assert.equal(seen[1].destination.startsWith(dataDir), true);
  assert.equal(result.manifest.media.length, 1);
  assert.equal(result.manifest.media[0].sourceId, 'source-1');
  assert.equal(result.manifest.media[0].sourceUrl, sources[0].url);
  assert.equal(result.manifest.media[0].selectedMediaUrl, selectedMediaUrl);
  assert.match(result.manifest.media[0].mediaSelectionId, /^media-selection-[a-f0-9]{24}$/);
  assert.equal(result.manifest.scenes['scene-1'], result.manifest.media[0].mediaSelectionId);
  assert.equal(result.manifest.scenes['scene-2'], result.manifest.media[0].mediaSelectionId);
  assert.equal((await stat(result.manifestAbsolutePath)).isFile(), true);
});

test('unsupported selected media response and interrupted discovery fail closed and leave no authoritative-ready manifest', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bright-ingest-fail-'));
  let call = 0;
  const unsupported = createMediaIngestService({
    fetcher: {
      async fetchToFile(_url, destination) {
        call += 1;
        await mkdir(join(destination, '..'), {recursive: true});
        if (call === 1) {
          const html = '<meta property="og:image" content="https://cdn.example.test/not-media">';
          await writeFile(destination, html);
          return {url: sources[0].url, mimeType: 'text/html', bytes: Buffer.byteLength(html), path: destination};
        }
        await writeFile(destination, 'html');
        return {url: 'https://cdn.example.test/not-media', mimeType: 'text/html', bytes: 4, path: destination};
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
