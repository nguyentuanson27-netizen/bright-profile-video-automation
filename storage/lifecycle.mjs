import {randomUUID} from 'node:crypto';
import {existsSync, rmSync} from 'node:fs';
import {copyFile, mkdir, rename, statfs} from 'node:fs/promises';
import path from 'node:path';
import {AppError} from '../domain/errors.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const GIB = 1024 ** 3;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,160}$/;
const HEAVY_ARTIFACT_KINDS = new Set(['approved-media', 'tts-audio', 'rendered-video']);
const UNAPPROVED_PROJECT_STATES = new Set(['draft', 'researching', 'research_ready', 'generating', 'review_required']);
const TRANSIENT_PROJECT_STATES = new Set(['failed', 'cancelled']);
const ACTIVE_JOB_STATES = new Set(['queued', 'running']);

export const STORAGE_DEFAULTS = Object.freeze({
  completedRetentionDays: 30,
  transientRetentionDays: 7,
  warningFreePercent: 25,
  hardFreePercent: 15,
  hardFreeBytes: 20 * GIB,
});

const safeSegment = (value, code = 'STORAGE_PATH_INVALID') => {
  const text = String(value || '');
  if (!SAFE_SEGMENT.test(text) || text === '.' || text === '..') {
    throw new AppError(code, 'Storage path segment is invalid', {status: 500});
  }
  return text;
};

const rootResolver = (dataDir) => {
  if (!path.isAbsolute(dataDir)) throw new TypeError('storage dataDir must be absolute');
  const root = path.resolve(dataDir);
  return {
    root,
    resolve(relativePath) {
      if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
        throw new AppError('STORAGE_PATH_INVALID', 'Storage path is invalid', {status: 500});
      }
      const absolute = path.resolve(root, relativePath);
      if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) {
        throw new AppError('STORAGE_PATH_INVALID', 'Storage path escapes the data directory', {status: 500});
      }
      return absolute;
    },
  };
};

const positiveNumber = (value, name) => {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} is invalid`);
  return value;
};

const statfsBytes = async (dataDir, statfsImpl) => {
  const stats = await statfsImpl(dataDir, {bigint: true});
  const bsize = BigInt(stats?.bsize ?? 0);
  const blocks = BigInt(stats?.blocks ?? 0);
  const available = BigInt(stats?.bavail ?? stats?.bfree ?? 0);
  const total = bsize * blocks;
  const free = bsize * available;
  if (total <= 0n || free < 0n || free > total
    || total > BigInt(Number.MAX_SAFE_INTEGER) || free > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError('DISK_STATS_INVALID', 'Filesystem capacity could not be measured safely', {status: 500});
  }
  return {totalBytes: Number(total), freeBytes: Number(free)};
};

export function createDiskGuard({
  dataDir,
  statfsImpl = statfs,
  warningFreePercent = STORAGE_DEFAULTS.warningFreePercent,
  hardFreePercent = STORAGE_DEFAULTS.hardFreePercent,
  hardFreeBytes = STORAGE_DEFAULTS.hardFreeBytes,
} = {}) {
  if (!path.isAbsolute(dataDir || '')) throw new TypeError('disk guard dataDir must be absolute');
  if (typeof statfsImpl !== 'function') throw new TypeError('statfsImpl must be a function');
  positiveNumber(warningFreePercent, 'warningFreePercent');
  positiveNumber(hardFreePercent, 'hardFreePercent');
  positiveNumber(hardFreeBytes, 'hardFreeBytes');
  if (warningFreePercent > 100 || hardFreePercent > 100 || hardFreePercent > warningFreePercent) {
    throw new TypeError('disk guard percentage thresholds are invalid');
  }

  const inspect = async () => {
    const {totalBytes, freeBytes} = await statfsBytes(dataDir, statfsImpl);
    const freePercent = (freeBytes / totalBytes) * 100;
    return {
      totalBytes,
      freeBytes,
      freePercent,
      warning: freePercent < warningFreePercent,
      blocked: freePercent < hardFreePercent || freeBytes < hardFreeBytes,
    };
  };

  return Object.freeze({
    inspect,
    async assertExpensiveWorkAllowed(stage) {
      const status = await inspect();
      if (status.blocked) {
        throw new AppError('DISK_SPACE_LOW', 'Insufficient disk space to start expensive media work', {
          status: 507,
          retryable: true,
          details: {
            stage: String(stage || 'unknown').slice(0, 64),
            freeBytes: status.freeBytes,
            freePercent: status.freePercent,
          },
        });
      }
      return status;
    },
  });
}

const cutoffIso = (now, days) => new Date(now.getTime() - days * DAY_MS).toISOString();

export function createStorageLifecycle({
  db,
  dataDir,
  clock = () => new Date(),
  completedRetentionDays = STORAGE_DEFAULTS.completedRetentionDays,
  transientRetentionDays = STORAGE_DEFAULTS.transientRetentionDays,
} = {}) {
  if (!db?.prepare || typeof db.backup !== 'function') throw new TypeError('storage lifecycle database is required');
  const resolver = rootResolver(dataDir);
  positiveNumber(completedRetentionDays, 'completedRetentionDays');
  positiveNumber(transientRetentionDays, 'transientRetentionDays');

  const listArtifacts = db.prepare(`
    SELECT a.id, a.project_id, a.kind, a.relative_path, a.created_at, p.status AS project_status
    FROM artifacts a
    JOIN projects p ON p.id = a.project_id
    ORDER BY a.created_at, a.id
  `);
  const getArtifact = db.prepare(`
    SELECT a.id, a.project_id, a.kind, a.relative_path, a.created_at, p.status AS project_status
    FROM artifacts a
    JOIN projects p ON p.id = a.project_id
    WHERE a.id = ?
  `);
  const deleteArtifact = db.prepare('DELETE FROM artifacts WHERE id = ?');
  const projectHasActiveJob = db.prepare(`
    SELECT 1 AS active FROM jobs
    WHERE project_id = ? AND status IN ('queued', 'running')
    LIMIT 1
  `);
  const listJobs = db.prepare('SELECT id, project_id, status, updated_at FROM jobs ORDER BY updated_at, id');
  const getJob = db.prepare('SELECT id, project_id, status, updated_at FROM jobs WHERE id = ?');
  const listManifests = db.prepare(`
    SELECT id, project_id, relative_path FROM artifacts
    WHERE kind = 'media-manifest'
    ORDER BY project_id, id
  `);

  const eligibleArtifact = (row, now) => {
    if (!row || !HEAVY_ARTIFACT_KINDS.has(row.kind)) return false;
    if (projectHasActiveJob.get(row.project_id)) return false;
    if (row.project_status === 'completed') {
      return row.created_at <= cutoffIso(now, completedRetentionDays);
    }
    if (TRANSIENT_PROJECT_STATES.has(row.project_status) || UNAPPROVED_PROJECT_STATES.has(row.project_status)) {
      return row.created_at <= cutoffIso(now, transientRetentionDays);
    }
    return false;
  };

  const eligibleWork = (row, now) => row
    && !ACTIVE_JOB_STATES.has(row.status)
    && row.updated_at <= cutoffIso(now, transientRetentionDays);

  const planCleanup = () => {
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('cleanup clock returned an invalid date');
    const candidates = [];

    for (const row of listArtifacts.all()) {
      if (!eligibleArtifact(row, now)) continue;
      const absolute = resolver.resolve(row.relative_path);
      candidates.push({type: 'artifact', id: row.id, projectId: row.project_id, path: path.relative(resolver.root, absolute)});
    }

    for (const row of listJobs.all()) {
      if (!eligibleWork(row, now)) continue;
      const relative = path.join('work', safeSegment(row.id));
      const absolute = resolver.resolve(relative);
      if (existsSync(absolute)) {
        candidates.push({type: 'work', jobId: row.id, projectId: row.project_id, path: path.relative(resolver.root, absolute)});
      }
    }
    return {now, candidates};
  };

  const removeArtifact = db.transaction(({candidate, now}) => {
    const row = getArtifact.get(candidate.id);
    if (!eligibleArtifact(row, now)) return false;
    const absolute = resolver.resolve(row.relative_path);
    rmSync(absolute, {force: true});
    deleteArtifact.run(row.id);
    return true;
  });

  const removeWork = db.transaction(({candidate, now}) => {
    const row = getJob.get(candidate.jobId);
    if (!eligibleWork(row, now)) return false;
    const relative = path.join('work', safeSegment(row.id));
    const absolute = resolver.resolve(relative);
    rmSync(absolute, {recursive: true, force: true});
    return true;
  });

  return Object.freeze({
    async cleanup({dryRun = false} = {}) {
      if (typeof dryRun !== 'boolean') throw new TypeError('dryRun must be a boolean');
      const {now, candidates} = planCleanup();
      if (dryRun) return {dryRun: true, candidates, deleted: []};

      const deleted = [];
      for (const candidate of candidates) {
        const removed = candidate.type === 'artifact'
          ? removeArtifact.immediate({candidate, now})
          : removeWork.immediate({candidate, now});
        if (removed) deleted.push(candidate);
      }
      return {dryRun: false, candidates, deleted};
    },

    async backup({name} = {}) {
      const safeName = safeSegment(name, 'BACKUP_NAME_INVALID');
      const backupRoot = resolver.resolve('backups');
      const destination = resolver.resolve(path.join('backups', safeName));
      if (existsSync(destination)) {
        throw new AppError('BACKUP_EXISTS', 'Backup destination already exists', {status: 409});
      }

      await mkdir(backupRoot, {recursive: true});
      const temporary = resolver.resolve(path.join('backups', `.tmp-${safeName}-${randomUUID()}`));
      await mkdir(temporary, {recursive: false});
      try {
        const temporaryDatabase = path.join(temporary, 'app.sqlite');
        await db.backup(temporaryDatabase);

        for (const manifest of listManifests.all()) {
          const source = resolver.resolve(manifest.relative_path);
          if (!existsSync(source)) {
            throw new AppError('BACKUP_MANIFEST_MISSING', 'Required approved manifest is missing', {status: 409});
          }
          const target = path.resolve(temporary, manifest.relative_path);
          if (target === temporary || !target.startsWith(`${temporary}${path.sep}`)) {
            throw new AppError('STORAGE_PATH_INVALID', 'Backup manifest path escapes the backup directory', {status: 500});
          }
          await mkdir(path.dirname(target), {recursive: true});
          await copyFile(source, target);
        }

        await rename(temporary, destination);
        return {
          status: 'completed',
          destination,
          databasePath: path.join(destination, 'app.sqlite'),
          manifests: listManifests.all().length,
        };
      } catch (error) {
        rmSync(temporary, {recursive: true, force: true});
        throw error;
      }
    },
  });
}
