import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {loadConfig} from '../../app/config.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createDefaultWorkerHandlers} from '../../worker.mjs';

test('worker boots its default handlers without an OpenAI API key for imported ChatGPT drafts', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bright-worker-bootstrap-'));
  const config = loadConfig({
    BRIGHT_DATA_DIR: dataDir,
    BRIGHT_DATABASE_PATH: join(dataDir, 'bright-profile.sqlite'),
    OPENAI_API_KEY: '',
  });
  const db = openDatabase(config.databasePath);
  migrateDatabase(db);
  const repos = createRepositories(db);

  try {
    const handlers = createDefaultWorkerHandlers({config, db, repos});
    assert.deepEqual(Object.keys(handlers).sort(), ['generation', 'media_ingest', 'render', 'research', 'tts']);
  } finally {
    db.close();
  }
});
