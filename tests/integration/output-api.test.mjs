import test from 'node:test';
import assert from 'node:assert/strict';

import {matchRoute} from '../../app/http/router.mjs';

test('output download route is fixed to the project authoritative output resource', () => {
  assert.deepEqual(
    matchRoute('GET', '/api/projects/project-1/artifacts/output'),
    {name: 'projects.artifacts.output', id: 'project-1'},
  );
  assert.equal(matchRoute('GET', '/api/projects/project-1/artifacts/../../etc/passwd'), null);
  assert.equal(matchRoute('GET', '/api/projects/project-1/artifacts/output/other'), null);
});
