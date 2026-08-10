import http from 'node:http';
import path from 'node:path';
import {loadConfig} from './app/config.mjs';
import {createHttpHandler} from './app/http/router.mjs';
import {createResearchProjectService} from './app/services/research-project.mjs';
import {createOpenAiResearchProvider} from './providers/research/openai.mjs';
import {createRepositories, migrateDatabase, openDatabase} from './storage/db.mjs';
import {createProjectStateStore} from './storage/project-state.mjs';

const config = loadConfig();
const databasePath = path.join(config.dataDir, 'app.sqlite');
const db = openDatabase({filename: databasePath});
migrateDatabase(db);

const repositories = createRepositories(db);
const projectStateStore = createProjectStateStore(db);
const researchProvider = createOpenAiResearchProvider();
const researchService = createResearchProjectService({
  repositories,
  projectStateStore,
  researchProvider,
});

const server = http.createServer(createHttpHandler({
  repositories,
  researchService,
  maxBodyBytes: config.maxBodyBytes,
}));

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close((error) => {
    try {
      if (db.open) db.close();
    } finally {
      if (error) {
        console.error(JSON.stringify({event: 'app.shutdown_failed'}));
        process.exitCode = 1;
      }
    }
  });
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

server.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({
    event: 'app.started',
    port: config.port,
    database: 'app.sqlite',
  }));
});
