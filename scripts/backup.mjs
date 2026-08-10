import path from 'node:path';
import {loadConfig} from '../app/config.mjs';
import {migrateDatabase, openDatabase} from '../storage/db.mjs';
import {createStorageLifecycle} from '../storage/lifecycle.mjs';

const usage = 'Usage: npm run storage:backup -- [--name backup-name]';
const defaultName = () => `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;

const parseArgs = (args) => {
  let name = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return {help: true, name: null};
    if (arg === '--name') {
      if (name !== null || !args[index + 1]) throw new Error('Backup name is invalid');
      name = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error('Unknown backup argument');
  }
  return {help: false, name: name || defaultName()};
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
    console.log(JSON.stringify(await lifecycle.backup({name: options.name}), null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({
    status: 'failed',
    error: typeof error?.code === 'string' ? error.code : (error?.name || 'BACKUP_FAILED'),
    message: String(error?.message || 'Backup failed').slice(0, 500),
  }));
  process.exitCode = 1;
} finally {
  if (db?.open) db.close();
}
