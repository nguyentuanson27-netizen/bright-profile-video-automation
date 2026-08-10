import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AppError} from '../../domain/errors.mjs';
import {createApprovalService} from '../../app/services/approve-project.mjs';
import {createMediaIngestService} from '../../app/services/media-ingest.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';
import {createProjectStateStore} from '../../storage/project-state.mjs';

const MEDIA_URL = 'https://cdn.example.com/media/unsafe-name.jpg?token=public';
const MEDIA_BODY = Buffer.from('deterministic-image-bytes');

const source = {
  sourceId: 'source-media',
  url: MEDIA_URL,
  platform: 'cdn.example.com',
  retrievedAt: '2026-08-10T00:00:00.000Z',
  retrievalStatus: 'available',
  excerpt: 'Public media source.',
  contentHash: 'b'.repeat(64),
  sourceType: 'page',
};

const generation = {
  researchSummary: 'Source-grounded summary.',
  claims: [{id: 'claim-1', text: 'Supported.', sourceIds: ['source-media'], status: 'supported'}],
  script: 'Script.',
  voiceover: {chunks: [{id: 'hero', start: 0, duration: 6, text: 'Voice.'}]},
  project: {
    duration: 6,
    creatorName: 'Creator',
    heroImage: 'asset://demo/hero.png',
    scenes: [
      {id: 'hero', type: 'hero', start: 0, duration: 3},
      {id: 'source', type: 'source', start: 3, duration: 3, mediaUrl: MEDIA_URL, source: 'Public source'},
    ],
  },
};

function createApprovedFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-media-'));
  const dataDir = path.join(directory, 'data');
  const db = openDatabase({filename: path.join(dataDir, 'app.sqlite')});
  migrateDatabase(db);
  const repositories = createRepositories(db);
  const projectStateStore = createProjectStateStore(db);
  repositories.projects.create({
    id: 'project-1', topic: 'Creator', status: 'review_required', input: {topic: 'Creator'},
  });
  repositories.sources.upsert({projectId: 'project-1', record: source});
  const payload = {
    revisionId: 'revision-1',
    projectId: 'project-1',
    topic: 'Creator',
    sources: [source],
    generation,
  };
  repositories.revisions.saveDraft({projectId: 'project-1', revisionId: 'revision-1', payload});
  const approvalService = createApprovalService({
    repositories,
    projectStateStore,
    clock: () => new Date('2026-08-10T00:10:00.000Z'),
  });
  const approved = approvalService.approve({
    projectId: 'project-1', revisionId: 'revision-1', approvedBy: 'operator',
  });
  return {directory, dataDir, db, repositories, projectStateStore, approvalService, approved};
}

test('approved remote media is ingested once with safe generated name and provenance manifest', async () => {
  const fixture = createApprovedFixture();
  try {
    const fetched = [];
    const artifactStore = createArtifactStore({dataDir: fixture.dataDir, repositories: fixture.repositories});
    const service = createMediaIngestService({
      repositories: fixture.repositories,
      approvalService: fixture.approvalService,
      artifactStore,
      fetchMedia: async (url) => {
        fetched.push(url);
        return {statusCode: 200, contentType: 'image/jpeg', body: MEDIA_BODY};
      },
    });

    const result = await service.ingest({projectId: 'project-1', revisionId: 'revision-1'});
    assert.deepEqual(fetched, [MEDIA_URL]);
    assert.equal(result.renderProject.heroImage, 'asset://demo/hero.png');
    assert.match(result.renderProject.scenes[1].mediaUrl, /^artifact:\/\/media-[a-f0-9]{24}$/);
    assert.equal(result.media.length, 1);
    assert.deepEqual(result.media[0].provenance, {
      sceneId: 'source',
      field: 'mediaUrl',
      sourceId: 'source-media',
      originalUrl: MEDIA_URL,
    });
    assert.match(result.media[0].artifact.contentHash, /^[a-f0-9]{64}$/);
    assert.match(result.media[0].artifact.relativePath, /^projects\/project-1\/media\/media-[a-f0-9]{24}\.jpg$/);
    assert.equal(result.media[0].artifact.relativePath.includes('unsafe-name'), false);
    assert.equal(existsSync(path.join(fixture.dataDir, result.media[0].artifact.relativePath)), true);

    assert.equal(result.manifestArtifact.kind, 'media-manifest');
    const manifestPath = path.join(fixture.dataDir, result.manifestArtifact.relativePath);
    const persistedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(persistedManifest.renderProject, result.renderProject);
    assert.equal(persistedManifest.approvedRevisionId, 'revision-1');
    assert.equal(persistedManifest.approvedPayloadHash, fixture.approved.payloadHash);

    const replay = await service.ingest({projectId: 'project-1', revisionId: 'revision-1'});
    assert.equal(replay.media[0].artifact.id, result.media[0].artifact.id);
    assert.equal(fixture.repositories.artifacts.listByProject('project-1').length, 2);
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, {recursive: true, force: true});
  }
});

test('ingest rejects unapproved revision, unsupported MIME, oversized body, and unsupported media schemes', async () => {
  const fixture = createApprovedFixture();
  try {
    const artifactStore = createArtifactStore({dataDir: fixture.dataDir, repositories: fixture.repositories});
    const service = createMediaIngestService({
      repositories: fixture.repositories,
      approvalService: fixture.approvalService,
      artifactStore,
      maxMediaBytes: 5,
      fetchMedia: async () => ({statusCode: 200, contentType: 'text/html', body: Buffer.from('123456')}),
    });

    await assert.rejects(
      () => service.ingest({projectId: 'project-1', revisionId: 'revision-1'}),
      (error) => error instanceof AppError
        && ['MEDIA_CONTENT_TYPE_REJECTED', 'MEDIA_BODY_TOO_LARGE'].includes(error.code),
    );

    repositoriesDraft(fixture.repositories, fixture.projectStateStore);
    await assert.rejects(
      () => service.ingest({projectId: 'project-1', revisionId: 'revision-draft'}),
      (error) => error instanceof AppError && error.code === 'APPROVED_REVISION_REQUIRED',
    );

    const approvedPayload = fixture.repositories.revisions.get('revision-1').payload;
    const badProject = structuredClone(approvedPayload.generation.project);
    badProject.scenes[1].mediaUrl = 'file:///etc/passwd';
    assert.throws(
      () => service.buildPlan({approvedRevision: fixture.repositories.revisions.get('revision-1'), renderProject: badProject}),
      (error) => error instanceof AppError && error.code === 'MEDIA_URL_SCHEME_REJECTED',
    );
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, {recursive: true, force: true});
  }
});

function repositoriesDraft(repositories, projectStateStore) {
  const approved = repositories.revisions.get('revision-1');
  projectStateStore.setStatus({projectId: 'project-1', status: 'review_required'});
  repositories.revisions.saveDraft({
    projectId: 'project-1',
    revisionId: 'revision-draft',
    payload: {
      revisionId: 'revision-draft',
      projectId: 'project-1',
      topic: approved.payload.topic,
      sources: approved.payload.sources,
      generation: approved.payload.generation,
    },
  });
}
