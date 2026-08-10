import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {AppError} from '../domain/errors.mjs';

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,160}$/;
const hashBuffer = (buffer) => createHash('sha256').update(buffer).digest('hex');

const safeSegment = (value, label) => {
  const text = String(value || '');
  if (!SAFE_SEGMENT.test(text) || text === '.' || text === '..') {
    throw new AppError('ARTIFACT_PATH_INVALID', `${label} is invalid`, {status: 500});
  }
  return text;
};

export function createArtifactStore({dataDir, repositories}) {
  if (!path.isAbsolute(dataDir)) throw new TypeError('artifact dataDir must be absolute');
  if (!repositories?.artifacts) throw new TypeError('artifact repository is required');
  const root = path.resolve(dataDir);

  const absoluteFor = (relativePath) => {
    const absolute = path.resolve(root, relativePath);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      throw new AppError('ARTIFACT_PATH_INVALID', 'Artifact path escapes the data directory', {status: 500});
    }
    return absolute;
  };

  const find = (projectId, id) => repositories.artifacts
    .listByProject(projectId)
    .find((artifact) => artifact.id === id) || null;

  const writeImmutable = ({projectId, id, kind, relativePath, buffer, contentHash}) => {
    safeSegment(projectId, 'Project ID');
    safeSegment(id, 'Artifact ID');
    const expectedHash = contentHash || hashBuffer(buffer);
    const target = absoluteFor(relativePath);
    mkdirSync(path.dirname(target), {recursive: true});

    if (existsSync(target)) {
      const existingHash = hashBuffer(readFileSync(target));
      if (existingHash !== expectedHash) {
        throw new AppError('ARTIFACT_CONTENT_CONFLICT', 'Artifact file exists with different content', {status: 409});
      }
    } else {
      const temporary = `${target}.tmp-${randomUUID()}`;
      try {
        writeFileSync(temporary, buffer, {flag: 'wx'});
        renameSync(temporary, target);
      } finally {
        rmSync(temporary, {force: true});
      }
    }

    return repositories.artifacts.create({
      id,
      projectId,
      kind,
      relativePath,
      contentHash: expectedHash,
    });
  };

  return Object.freeze({
    get(projectId, id) {
      const artifact = find(projectId, id);
      if (!artifact) return null;
      const absolutePath = absoluteFor(artifact.relativePath);
      return existsSync(absolutePath) ? {...artifact, absolutePath} : null;
    },

    writeMedia({projectId, id, extension, buffer, contentHash}) {
      const safeId = safeSegment(id, 'Artifact ID');
      const safeExtension = safeSegment(String(extension || '').replace(/^\./, ''), 'Artifact extension');
      if (!Buffer.isBuffer(buffer)) throw new TypeError('artifact buffer must be a Buffer');
      return writeImmutable({
        projectId,
        id: safeId,
        kind: 'approved-media',
        relativePath: path.posix.join('projects', safeSegment(projectId, 'Project ID'), 'media', `${safeId}.${safeExtension}`),
        buffer,
        contentHash,
      });
    },

    writeManifest({projectId, revisionId, id, value}) {
      const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
      return writeImmutable({
        projectId,
        id: safeSegment(id, 'Artifact ID'),
        kind: 'media-manifest',
        relativePath: path.posix.join(
          'projects',
          safeSegment(projectId, 'Project ID'),
          'revisions',
          safeSegment(revisionId, 'Revision ID'),
          'media-manifest.json',
        ),
        buffer: body,
        contentHash: hashBuffer(body),
      });
    },

    absolutePath(artifact) {
      return absoluteFor(artifact.relativePath);
    },
  });
}
