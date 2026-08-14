import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

import {createMediaIngestService, createMediaIngestStageHandler} from '../../app/services/ingest-media.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const sourceUrl = 'https://news.example.test/creator-profile';
const mediaUrl = 'https://cdn.example.test/creator-portrait.png';

const approvedDraft = {
  creatorName: 'Creator',
  claims: [{id: 'claim-1', text: 'Creator has a public profile.', sourceIds: ['source-1'], verified: true}],
  script: [{id: 'script-1', text: 'Creator profile.', start: 0, duration: 1, sourceIds: ['source-1']}],
  voiceover: {chunks: [{id: 'voice-1', text: 'Creator profile.', start: 0, duration: 1}]},
  scenes: [{id: 'scene-1', type: 'hero', start: 0, duration: 1, sourceIds: ['source-1']}],
  render: {duration: 1, renderScale: 1, crf: 20},
};

test('approved factual HTML source produces a separate immutable media selection and queues TTS', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bright-media-selection-'));
  const db = openDatabase(join(dataDir, 'app.sqlite'));
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db, {leaseMs: 1000});
  const artifacts = createArtifactStore(db);

  repos.projects.create({id: 'project-1', creator: 'Creator', topic: 'profile', status: 'review_required'});
  repos.sources.create({id: 'source-1', projectId: 'project-1', url: sourceUrl, status: 'available', payload: {title: 'Creator profile article'}});
  repos.revisions.create({
    id: 'revision-1', projectId: 'project-1', revisionNo: 1,
    payload: approvedDraft, payloadHash: 'a'.repeat(64),
  });
  repos.revisions.approve({
    projectId: 'project-1', revisionId: 'revision-1', expectedPayloadHash: 'a'.repeat(64),
    approvedAt: '2026-08-14T00:00:00.000Z',
  });
  repos.approval.createFirstDescendant({
    id: 'media-stage', projectId: 'project-1', revisionId: 'revision-1', type: 'media_ingest',
    state: 'queued', maxAttempts: 3, availableAtMs: 1,
    createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
  });

  const seen = [];
  const service = createMediaIngestService({
    dataDir,
    fetchOptions: {timeoutMs: 1000, maxBytes: 1024 * 1024, maxRedirects: 2},
    fetcher: {
      async fetchToFile(url, destination) {
        seen.push(url);
        await mkdir(dirname(destination), {recursive: true});
        if (url === sourceUrl) {
          const html = `<html><head><meta property="og:image" content="${mediaUrl}"></head><body>Factual article</body></html>`;
          await writeFile(destination, html);
          return {url, mimeType: 'text/html', bytes: Buffer.byteLength(html), path: destination};
        }
        assert.equal(url, mediaUrl);
        const bytes = Buffer.from('portrait-bytes');
        await writeFile(destination, bytes);
        return {url, mimeType: 'image/png', bytes: bytes.length, path: destination};
      },
    },
  });
  const handler = createMediaIngestStageHandler({repos, artifactStore: artifacts, service, nextMaxAttempts: 3});
  const runner = createJobRunner({
    jobs, workerId: 'worker-a', handlers: {media_ingest: handler}, leaseMs: 1000, now: () => 2,
  });

  assert.equal(await runner.runOnce(), true);
  assert.deepEqual(seen, [sourceUrl, mediaUrl]);
  assert.equal(repos.projects.get('project-1').status, 'tts');
  assert.equal(jobs.getCurrentStage('project-1').type, 'tts');

  const manifestArtifact = artifacts.getAuthoritative('project-1', 'revision-1', 'media_manifest');
  const manifest = JSON.parse(await readFile(resolve(dataDir, manifestArtifact.relativePath), 'utf8'));
  assert.equal(manifest.media[0].sourceUrl, sourceUrl);
  assert.equal(manifest.media[0].selectedMediaUrl, mediaUrl);
  assert.match(manifest.media[0].mediaSelectionId, /^media-selection-[a-f0-9]{24}$/);
  assert.equal(manifest.scenes['scene-1'], manifest.media[0].mediaSelectionId);
  assert.notEqual(manifest.scenes['scene-1'], 'source-1');
  db.close();
});
