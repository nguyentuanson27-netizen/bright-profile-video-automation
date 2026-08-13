import {openDatabase, migrateDatabase} from '../storage/db.mjs';

const args = process.argv.slice(2);
const equalsArg = args.find((arg) => arg.startsWith('--database='));
const databaseIndex = args.indexOf('--database');
const databasePath = equalsArg?.slice('--database='.length)
  || (databaseIndex >= 0 ? args[databaseIndex + 1] : undefined);

if (!databasePath) {
  console.error('usage: npm run db:migrate -- --database <path>');
  process.exitCode = 2;
} else {
  const db = openDatabase(databasePath);
  try {
    const version = migrateDatabase(db);
    console.log(`database schema version ${version}`);
  } finally {
    db.close();
  }
}
