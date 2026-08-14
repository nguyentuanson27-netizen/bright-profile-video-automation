import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createApprovalService} from '../../app/services/approve-project.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';

const draft = {
  creatorName: 'Creator',
  summary: 'Human-reviewed creator profile.',
  claims: [{id: 'claim-1', text: 'Creator reached 100 followers.', sourceIds: ['source-1'], verified: true}],
  script: [{id: 'script-1', text: 'Creator reached 100 followers.', start: 0, duration: 4, sourceIds: ['source-1']}],
  voiceover: {chunks: [{id: 'voice-1', text: 'Creator reached 100 followers.', start: 0, duration: 4}]},
  scenes: [{id: 'scene-1', type: 'claim', start: 0, duration: 4, sourceIds: ['source-1']}],
  render: {duration: 4},
};

const payloadHash = createHash('sha256').update(JSON.stringify(draft)).digest('hex');

test('approved project and immutable revision identity/hash survive database reopen', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'bright-approval-restart-')), 'app.sqlite');
  const db = openDatabase(databasePath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  repos.projects.create({id: 'project-1', creator: 'Creator', topic: 'career', instructions: '', status: 'draft'});
  repos.sources.create({
    id: 'source-1',
    projectId: 'project-1',
    url: 'https://research.example/profile',
    status: 'available',
    payload: {title: 'Profile'},
  });
  repos.revisions.create({
    id: 'revision-1',
    projectId: 'project-1',
    revisionNo: 1,
    payload: draft,
    payloadHash,
  });
  db.prepare("UPDATE projects SET status = 'review_required' WHERE id = ?").run('project-1');

  const approval = createApprovalService({
    repos,
    now: () => Date.parse('2026-08-14T05:00:00Z'),
    revisionIdFactory: () => 'unused-revision',
  });
  const approved = approval.approve('project-1');
  assert.equal(approved.project.status, 'approved');
  assert.equal(approved.project.currentRevisionId, 'revision-1');
  assert.equal(approved.project.approvedRevisionId, 'revision-1');
  assert.equal(approved.revision.payloadHash, payloadHash);
  const approvedAt = approved.revision.approvedAt;
  db.close();

  const reopened = openDatabase(databasePath);
  migrateDatabase(reopened);
  const reopenedRepos = createRepositories(reopened);
  const project = reopenedRepos.projects.get('project-1');
  const revision = reopenedRepos.revisions.get('revision-1');
  assert.equal(project.status, 'approved');
  assert.equal(project.currentRevisionId, 'revision-1');
  assert.equal(project.approvedRevisionId, 'revision-1');
  assert.equal(revision.payloadHash, payloadHash);
  assert.equal(revision.approvedAt, approvedAt);
  assert.throws(
    () => reopenedRepos.revisions.updatePayload({revisionId: 'revision-1', payload: {...draft, summary: 'mutated'}, payloadHash: '0'.repeat(64)}),
    /immutable/,
  );
  reopened.close();
});
