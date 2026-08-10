import path from 'node:path';
import {migrateDatabase, openDatabase} from '../storage/db.mjs';

const args = process.argv.slice(2);
const databaseIndex = args.indexOf('--database');
const databaseArg = databaseIndex >= 0 ? args[databaseIndex + 1] : null;
const filename = path.resolve(databaseArg || path.join(process.env.DATA_DIR || '/app/data', 'app.sqlite'));

const db = openDatabase({filename});
try {
  const version = migrateDatabase(db);
  console.log(JSON.stringify({event: 'db.migrated', version}));
} finally {
  db.close();
}
