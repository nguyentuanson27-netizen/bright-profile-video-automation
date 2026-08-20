import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {resolve, sep} from 'node:path';

import {AppError} from '../../domain/errors.mjs';
import {assertRelativeArtifactPath} from '../../storage/artifacts.mjs';

const outputUnavailable = () => new AppError(
  'OUTPUT_UNAVAILABLE',
  'Authoritative completed output is unavailable or failed integrity validation',
  {status: 409},
);

const hashFile = (file) => new Promise((resolveHash, rejectHash) => {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.once('error', rejectHash);
  stream.once('end', () => resolveHash(hash.digest('hex')));
});

export const createArtifactsApi = ({repos, artifactStore, dataDir} = {}) => {
  if (!repos?.projects) throw new TypeError('project repository is required');
  if (!artifactStore || typeof artifactStore.getAuthoritative !== 'function') throw new TypeError('artifact store is required');
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('dataDir is required');
  const root = resolve(dataDir);

  return Object.freeze({
    async getOutput(projectId) {
      const project = repos.projects.get(projectId);
      if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project not found', {status: 404});
      if (
        project.status !== 'completed'
        || !project.currentRevisionId
        || project.currentRevisionId !== project.approvedRevisionId
      ) {
        throw outputUnavailable();
      }
      const artifact = artifactStore.getAuthoritative(project.id, project.approvedRevisionId, 'output_mp4');
      if (!artifact || artifact.mimeType !== 'video/mp4' || !artifact.sha256 || !artifact.byteSize) throw outputUnavailable();
      try {
        assertRelativeArtifactPath(artifact.relativePath);
        const absolutePath = resolve(root, artifact.relativePath);
        if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) throw outputUnavailable();
        const info = await stat(absolutePath);
        if (!info.isFile() || info.size < 1 || info.size !== artifact.byteSize) throw outputUnavailable();
        if (await hashFile(absolutePath) !== artifact.sha256) throw outputUnavailable();
        return {absolutePath, byteSize: info.size, mimeType: 'video/mp4'};
      } catch (error) {
        if (error?.code === 'OUTPUT_UNAVAILABLE') throw error;
        throw outputUnavailable();
      }
    },

    async getArtifactById(artifactId) {
      const artifact = artifactStore.get(artifactId);
      if (!artifact) throw new AppError('ARTIFACT_NOT_FOUND', 'Artifact not found', {status: 404});
      if (artifact.mimeType !== 'video/mp4' || !artifact.sha256 || !artifact.byteSize) throw outputUnavailable();
      try {
        assertRelativeArtifactPath(artifact.relativePath);
        const absolutePath = resolve(root, artifact.relativePath);
        if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) throw outputUnavailable();
        const info = await stat(absolutePath);
        if (!info.isFile() || info.size < 1 || info.size !== artifact.byteSize) throw outputUnavailable();
        if (await hashFile(absolutePath) !== artifact.sha256) throw outputUnavailable();
        return {absolutePath, byteSize: info.size, mimeType: 'video/mp4'};
      } catch (error) {
        if (error?.code === 'OUTPUT_UNAVAILABLE' || error?.code === 'ARTIFACT_NOT_FOUND') throw error;
        throw outputUnavailable();
      }
    },
  });
};
