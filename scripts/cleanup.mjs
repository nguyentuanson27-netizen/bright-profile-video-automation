import path from 'node:path';
import {loadConfig} from '../app/config.mjs';
import {migrateDatabase, openDatabase} from '../storage/db.mjs';
import {createStorageLifecycle} from '../storage/lifecycle.mjs';

const usage = 'Usage: npm run storage:cleanup -- [--apply]';

const parseArgs = (args) => {
  let apply = false;
  for (const arg of args) {
    if (arg === '--apply') apply = true;
    else if (arg === '--help' || arg === '-h') return {help: true, apply: false};
    else throw new Error('Unknown cleanup argument');
  }
  return {help: false, apply};
};

let db;
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
  } else {
    const config = loadConfig();
    db = openDatabase({filename: path.join(config.dataDir, 'app.sqlite')});
    migrateDatabase(db);
    const lifecycle = createStorageLifecycle({
      db,
      dataDir: config.dataDir,
      completedRetentionDays: config.completedArtifactRetentionDays,
      transientRetentionDays: config.transientArtifactRetentionDays,
    });
    const result = await lifecycle.cleanup({dryRun: !options.apply});
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({
    status: 'failed',
    error: typeof error?.code === 'string' ? error.code : (error?.name || 'CLEANUP_FAILED'),
    message: String(error?.message || 'Cleanup failed').slice(0, 500),
  }));
  process.exitCode = 1;
} finally {
  if (db?.open) db.close();
}
