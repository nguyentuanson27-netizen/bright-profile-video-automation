import test from 'node:test';
import assert from 'node:assert/strict';

import {createRevisionsApi} from '../../app/http/revisions.mjs';

const repos = {
  projects: {get() { throw new Error('approval service should not be reached'); }},
  sources: {list() { throw new Error('approval service should not be reached'); }},
  revisions: {
    get() { throw new Error('approval service should not be reached'); },
    editCurrent() { throw new Error('approval service should not be reached'); },
    approve() { throw new Error('approval service should not be reached'); },
  },
};

test('draft edit API rejects direct scene mediaUrl/path input before domain persistence', () => {
  const api = createRevisionsApi({repos, revisionIdFactory: () => 'revision-1'});
  assert.throws(
    () => api.editDraft('project-1', {
      draft: {
        scenes: [{id: 'scene-1', mediaUrl: '../../private/file.mp4'}],
      },
    }),
    (error) => error.code === 'INVALID_REQUEST' && error.status === 400,
  );
});
