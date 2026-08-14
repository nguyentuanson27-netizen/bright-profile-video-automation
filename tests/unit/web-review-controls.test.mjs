import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const editor = await readFile(new URL('../../web/components/DraftEditor.jsx', import.meta.url), 'utf8');

test('structured review editor exposes bounded scene-plan controls without raw JSON', () => {
  for (const name of ['scene-type', 'scene-start', 'scene-duration', 'scene-source-ids']) {
    assert.match(editor, new RegExp(`name=["']${name}["']`), name);
  }
  assert.match(editor, /hero.*claim.*vertical.*source.*social.*stats/s);
  assert.doesNotMatch(editor, /raw json|JSON\.stringify\(working/i);
});

test('structured review editor exposes bounded render settings', () => {
  for (const name of ['render-duration', 'render-scale', 'render-crf']) {
    assert.match(editor, new RegExp(`name=["']${name}["']`), name);
  }
  assert.match(editor, /max=\{?1800\}?/);
  assert.match(editor, /min=\{?0\.25\}?/);
  assert.match(editor, /max=\{?2\}?/);
  assert.match(editor, /min=\{?16\}?/);
  assert.match(editor, /max=\{?35\}?/);
});
