import {createHash} from 'node:crypto';
import {AppError} from '../../domain/errors.mjs';
import {safeFetchBuffer} from '../../security/safe-fetch.mjs';

const MIME_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['video/quicktime', 'mov'],
]);
const ALLOWED_MIME = [...MIME_EXTENSIONS.keys()];
const DEFAULT_MAX_MEDIA_BYTES = 100 * 1024 * 1024;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => new URL(value).href;
const mediaIdFor = (url) => `media-${sha256(url).slice(0, 24)}`;
const manifestIdFor = (revision) => `media-manifest-${sha256(`${revision.revisionId}:${revision.payloadHash}`).slice(0, 24)}`;

const classifyUrl = (value) => {
  if (!value) return 'empty';
  if (/^https?:\/\//i.test(value)) return 'remote';
  if (/^(asset|artifact):\/\//i.test(value)) return 'trusted';
  throw new AppError('MEDIA_URL_SCHEME_REJECTED', 'Media URL scheme is not allowed', {status: 400});
};

const defaultFetchMedia = (url, {maxMediaBytes}) => safeFetchBuffer(url, {
  maxBytes: maxMediaBytes,
  allowedContentTypes: ALLOWED_MIME,
  accept: ALLOWED_MIME.join(', '),
});

const sourceIdForUrl = (sources, url) => {
  const target = canonical(url);
  return sources.find((source) => {
    try {
      return canonical(source.url) === target;
    } catch {
      return false;
    }
  })?.sourceId || null;
};

export function createMediaIngestService({
  repositories,
  approvalService,
  artifactStore,
  fetchMedia = defaultFetchMedia,
  maxMediaBytes = DEFAULT_MAX_MEDIA_BYTES,
}) {
  if (!repositories?.projects || !repositories?.revisions) throw new TypeError('media ingest repositories are required');
  if (!approvalService?.assertRenderAllowed) throw new TypeError('approvalService is required');
  if (!artifactStore?.writeMedia || !artifactStore?.writeManifest) throw new TypeError('artifactStore is required');
  if (typeof fetchMedia !== 'function') throw new TypeError('fetchMedia must be a function');
  if (!Number.isSafeInteger(maxMediaBytes) || maxMediaBytes < 1) throw new TypeError('maxMediaBytes is invalid');

  const buildPlan = ({approvedRevision, renderProject = approvedRevision?.payload?.generation?.project}) => {
    if (!approvedRevision || approvedRevision.status !== 'approved') {
      throw new AppError('APPROVED_REVISION_REQUIRED', 'Approved revision is required for media ingest', {status: 409});
    }
    const project = structuredClone(renderProject);
    const targets = [];

    const register = ({container, field, sceneId = null}) => {
      const value = container?.[field];
      const kind = classifyUrl(value);
      if (kind !== 'remote') return;
      const url = canonical(value);
      targets.push({container, field, sceneId, url});
    };

    register({container: project, field: 'heroImage'});
    for (const scene of project.scenes || []) register({container: scene, field: 'mediaUrl', sceneId: scene.id || null});
    return {renderProject: project, targets};
  };

  return Object.freeze({
    buildPlan,

    async ingest({projectId, revisionId}) {
      const approvedRevision = approvalService.assertRenderAllowed({projectId, revisionId});
      const plan = buildPlan({approvedRevision});
      const byUrl = new Map();
      const media = [];

      for (const target of plan.targets) {
        let entry = byUrl.get(target.url);
        if (!entry) {
          const artifactId = mediaIdFor(target.url);
          let artifact = artifactStore.get(projectId, artifactId);
          if (!artifact) {
            const response = await fetchMedia(target.url, {maxMediaBytes});
            if (!response || !Buffer.isBuffer(response.body)) {
              throw new AppError('MEDIA_RESPONSE_INVALID', 'Media fetch returned an invalid body', {status: 502});
            }
            if (Number(response.statusCode) < 200 || Number(response.statusCode) >= 300) {
              throw new AppError('MEDIA_FETCH_FAILED', 'Media source could not be fetched', {status: 502, retryable: true});
            }
            if (response.body.length > maxMediaBytes) {
              throw new AppError('MEDIA_BODY_TOO_LARGE', 'Media exceeds the configured size limit', {status: 413});
            }
            const contentType = String(response.contentType || '').split(';', 1)[0].trim().toLowerCase();
            const extension = MIME_EXTENSIONS.get(contentType);
            if (!extension) {
              throw new AppError('MEDIA_CONTENT_TYPE_REJECTED', 'Media content type is not supported', {status: 415});
            }
            const contentHash = sha256(response.body);
            artifact = artifactStore.writeMedia({
              projectId,
              id: artifactId,
              extension,
              buffer: response.body,
              contentHash,
            });
          }

          entry = {artifact, originalUrl: target.url};
          byUrl.set(target.url, entry);
        }

        target.container[target.field] = `artifact://${entry.artifact.id}`;
        media.push({
          artifact: entry.artifact,
          provenance: {
            sceneId: target.sceneId,
            field: target.field,
            sourceId: sourceIdForUrl(approvedRevision.payload.sources || [], target.url),
            originalUrl: target.url,
          },
        });
      }

      const manifest = {
        projectId,
        approvedRevisionId: approvedRevision.revisionId,
        approvedPayloadHash: approvedRevision.payloadHash,
        renderProject: plan.renderProject,
        media: media.map(({artifact, provenance}) => ({artifactId: artifact.id, contentHash: artifact.contentHash, provenance})),
      };
      const manifestArtifact = artifactStore.writeManifest({
        projectId,
        revisionId,
        id: manifestIdFor(approvedRevision),
        value: manifest,
      });
      return {...manifest, media, manifestArtifact};
    },
  });
}
