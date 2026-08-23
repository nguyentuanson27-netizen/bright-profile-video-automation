import {createHash, randomUUID} from 'node:crypto';
import {AppError, ErrorCodes} from '../../domain/errors.mjs';
import {
  APPROVAL_MODES,
  forEachDraftSourceEntry,
  PROJECT_ORIGINS,
  validateApproveProjectInput,
  validateDraft,
  validateEditDraftInput,
  validateImportProjectInput,
  validateProjectStatusOutput,
} from '../../domain/schemas.mjs';
import {
  generateDownloadToken,
  verifyDownloadToken,
} from '../../security/download-token.mjs';
import {assertValidBearerToken} from '../../security/integration-auth.mjs';

const invalidRequest = (message) => new AppError('INVALID_REQUEST', message, {status: 400});
const projectNotFound = () => new AppError(ErrorCodes.PROJECT_NOT_FOUND, 'Project not found', {status: 404});

const generatedId = (factory, name) => {
  const value = factory();
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new TypeError(`${name} must return a non-empty bounded string`);
  }
  return value;
};

const hashPayload = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const rejectManagedMediaFields = (draft) => {
  if (!Array.isArray(draft?.scenes)) return;
  for (const scene of draft.scenes) {
    if (scene && typeof scene === 'object' && !Array.isArray(scene) && Object.hasOwn(scene, 'mediaUrl')) {
      throw invalidRequest('scene.mediaUrl is managed by the media workflow and cannot be edited directly');
    }
  }
};

const prepareImportedDraft = ({draft, evidenceBundle, sources}) => {
  const sourceIdsByUrl = new Map(sources.map((source) => [source.url, source.id]));
  const sourceIdsByEvidenceId = new Map();
  for (const evidence of evidenceBundle.evidence) {
    const sourceIds = [];
    for (const source of evidence.sources ?? []) {
      const sourceId = sourceIdsByUrl.get(source.canonicalUrl || source.url);
      if (sourceId && !sourceIds.includes(sourceId)) sourceIds.push(sourceId);
    }
    if (sourceIds.length === 0) {
      throw invalidRequest(`Evidence ${evidence.id} has no imported source provenance`);
    }
    sourceIdsByEvidenceId.set(evidence.id, sourceIds);
  }

  const reviewDraft = structuredClone(draft);
  forEachDraftSourceEntry(reviewDraft, (entry) => {
    if (entry.sourceIds === undefined) return;
    const sourceIds = new Set();
    for (const evidenceId of entry.sourceIds) {
      const mappedSourceIds = sourceIdsByEvidenceId.get(evidenceId);
      if (!mappedSourceIds) {
        throw invalidRequest(`Evidence ${evidenceId} has no imported source provenance`);
      }
      for (const sourceId of mappedSourceIds) sourceIds.add(sourceId);
    }
    entry.sourceIds = [...sourceIds];
  });
  rejectManagedMediaFields(reviewDraft);
  for (const claim of reviewDraft.claims) {
    claim.verified = false;
    delete claim.overrideReason;
  }
  validateDraft(reviewDraft, {knownSourceIds: sources.map((source) => source.id)});
  return reviewDraft;
};

export const createIntegrationsApi = ({
  repos,
  jobs,
  artifactStore,
  dataDir: _dataDir,
  serviceToken,
  downloadSigningSecret,
  mcpPublicUrl,
  maxActiveProjects = 3,
  now = Date.now,
  nowMs = Date.now,
  projectIdFactory = randomUUID,
  stageIdFactory = randomUUID,
  sourceIdFactory = randomUUID,
  revisionIdFactory = randomUUID,
  generationMaxAttempts = 4,
  mediaIngestMaxAttempts = 4,
} = {}) => {
  if (!repos?.projects || !repos?.sources || !repos?.revisions) {
    throw new TypeError('repositories are required');
  }
  if (!jobs || typeof jobs.startGeneration !== 'function') {
    throw new TypeError('jobs store is required');
  }

  const signingSecret = (downloadSigningSecret || serviceToken || '').trim();

  const assertAuth = (authHeader) => {
    assertValidBearerToken(authHeader, serviceToken, {
      errorCode: ErrorCodes.UNAUTHORIZED,
      errorMessage: 'Unauthorized',
    });
  };

  const assertDownloadAuth = (authHeader, queryToken, artifactId) => {
    if (queryToken) {
      if (!signingSecret || signingSecret.length < 16) {
        throw new AppError('AUTH_NOT_CONFIGURED', 'Download signing secret is not configured with minimum 16 characters', {status: 500});
      }
      const verified = verifyDownloadToken({token: queryToken, secret: signingSecret, nowMs: nowMs()});
      if (verified.artifactId !== artifactId) {
        throw new AppError(ErrorCodes.DOWNLOAD_TOKEN_INVALID, 'Token is not valid for this artifact', {status: 401});
      }
      return verified;
    }
    assertValidBearerToken(authHeader, serviceToken, {
      errorCode: ErrorCodes.UNAUTHORIZED,
      errorMessage: 'Unauthorized',
    });
    return null;
  };

  const requireProject = (projectId) => {
    const project = repos.projects.get(projectId);
    if (!project) throw projectNotFound();
    return project;
  };

  const projectToStatusOutput = (project) => {
    const currentRevision = project.currentRevisionId ? repos.revisions.get(project.currentRevisionId) : null;
    const currentStage = jobs.getCurrentStage(project.id);
    let outputArtifact = null;
    if (project.approvedRevisionId && artifactStore?.getAuthoritative) {
      outputArtifact = artifactStore.getAuthoritative(project.id, project.approvedRevisionId, 'output_mp4');
    }

    let downloadUrl = undefined;
    if (outputArtifact) {
      if (!signingSecret || signingSecret.length < 16) {
        throw new AppError(
          'AUTH_NOT_CONFIGURED',
          'Download signing secret must be configured with at least 16 characters to generate signed artifact URLs',
          {status: 500},
        );
      }
      const token = generateDownloadToken({
        projectId: project.id,
        revisionId: project.approvedRevisionId,
        artifactId: outputArtifact.id,
        secret: signingSecret,
        ttlSeconds: 900,
        nowMs: nowMs(),
      });
      const query = `?token=${encodeURIComponent(token)}`;
      const baseUrl = (mcpPublicUrl || '').trim().replace(/\/+$/, '');
      const path = `/artifacts/${encodeURIComponent(outputArtifact.id)}/download${query}`;
      downloadUrl = baseUrl ? `${baseUrl}${path}` : path;
    }

    const output = {
      projectId: project.id,
      status: project.status,
      origin: project.origin,
      currentRevision: currentRevision ? {
        id: currentRevision.id,
        payloadHash: currentRevision.payloadHash,
        draft: currentRevision.payload,
      } : undefined,
      progress: currentStage ? {
        currentStage: currentStage.type,
        stageStatus: currentStage.state,
        attemptCount: currentStage.attemptCount,
        failureRetryable: currentStage.retryable,
        failureCode: currentStage.errorCode ?? undefined,
      } : undefined,
      evidenceSummary: project.research?.stats ? {
        inputItems: project.research.stats.inputItems,
        retainedEvidence: project.research.stats.retainedEvidence,
        conflictGroups: project.research.stats.conflictGroups,
        rejectedItems: project.research.stats.rejectedItems,
      } : undefined,
      output: outputArtifact ? {
        artifactId: outputArtifact.id,
        downloadUrl,
        sizeBytes: outputArtifact.byteSize,
        sha256: outputArtifact.sha256,
      } : undefined,
    };

    return validateProjectStatusOutput(output);
  };

  return Object.freeze({
    assertAuth,
    assertDownloadAuth,

    importProject(body) {
      const input = validateImportProjectInput(body);
      const handoffParameters = {
        creator: input.creator,
        topic: input.topic,
        instructions: input.instructions ?? '',
        evidenceBundle: input.evidenceBundle,
      };
      if (input.draft !== undefined) handoffParameters.draft = input.draft;
      const incomingFingerprint = hashPayload(handoffParameters);

      const projectId = generatedId(projectIdFactory, 'projectIdFactory');
      const stageId = input.draft ? null : generatedId(stageIdFactory, 'stageIdFactory');
      const timestamp = new Date(now()).toISOString();

      // Extract sources from evidence items
      const sourceMap = new Map();
      for (const item of input.evidenceBundle.evidence ?? []) {
        for (const src of item.sources ?? []) {
          const key = src.canonicalUrl || src.url;
          if (!sourceMap.has(key)) {
            sourceMap.set(key, {
              id: generatedId(sourceIdFactory, 'sourceIdFactory'),
              projectId,
              url: key,
              status: 'available',
              payload: {
                title: src.title || src.publisher || key,
                publisher: src.publisher,
                relationship: src.sourceRelationship || 'primary_profile',
                sourceType: src.sourceType || 'article',
                excerpt: src.excerpt,
              },
              createdAt: timestamp,
              updatedAt: timestamp,
            });
          }
        }
      }

      const sources = Array.from(sourceMap.values());
      const importedDraft = input.draft
        ? prepareImportedDraft({draft: input.draft, evidenceBundle: input.evidenceBundle, sources})
        : null;
      const projectRecord = {
        id: projectId,
        creator: input.creator,
        topic: input.topic,
        instructions: input.instructions ?? '',
        status: importedDraft ? 'review_required' : 'generating',
        origin: PROJECT_ORIGINS.CHATGPT_MCP,
        idempotencyKey: input.idempotencyKey,
        research: input.evidenceBundle,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      const result = repos.projects.importProject({
        project: projectRecord,
        sources,
        initialStage: stageId ? {
          id: stageId,
          maxAttempts: generationMaxAttempts,
          createdAt: timestamp,
          availableAtMs: nowMs(),
        } : null,
        initialDraft: importedDraft ? {
          id: generatedId(revisionIdFactory, 'revisionIdFactory'),
          payload: importedDraft,
          payloadHash: hashPayload(importedDraft),
          createdAt: timestamp,
        } : null,
        maxActiveProjects,
        incomingFingerprint,
      });

      return {
        project: projectToStatusOutput(result.project),
        stage: result.stage,
        isExisting: result.isExisting,
      };
    },

    getProjectStatus(projectId) {
      const project = requireProject(projectId);
      return projectToStatusOutput(project);
    },

    editDraft(projectId, body) {
      requireProject(projectId);
      const knownSourceIds = repos.sources.list(projectId).map((s) => s.id);
      const input = validateEditDraftInput(body, {knownSourceIds});
      if (input.projectId !== projectId) {
        throw invalidRequest('projectId in payload does not match route');
      }
      rejectManagedMediaFields(input.draft);

      const currentRevision = repos.revisions.get(input.revisionId);
      if (!currentRevision || currentRevision.projectId !== projectId) {
        throw new AppError(ErrorCodes.REVISION_NOT_FOUND, 'Revision not found', {status: 404});
      }
      if (currentRevision.payloadHash !== input.expectedPayloadHash) {
        throw new AppError(
          ErrorCodes.REVISION_HASH_MISMATCH,
          'Expected revision payload hash does not match current revision',
          {status: 409},
        );
      }

      const payloadJson = JSON.stringify(input.draft);
      const payloadHash = createHash('sha256').update(payloadJson).digest('hex');

      const updated = repos.revisions.editCurrent({
        projectId,
        revisionId: generatedId(revisionIdFactory, 'revisionIdFactory'),
        expectedRevisionId: input.revisionId,
        expectedPayloadHash: input.expectedPayloadHash,
        payload: input.draft,
        payloadHash,
      });

      return {
        project: projectToStatusOutput(updated.project),
        revision: updated.revision,
      };
    },

    approveProject(projectId, body) {
      const project = requireProject(projectId);
      const input = validateApproveProjectInput(body);
      if (input.projectId !== projectId) {
        throw invalidRequest('projectId in payload does not match route');
      }

      const currentRevision = repos.revisions.get(input.revisionId);
      if (!currentRevision || currentRevision.projectId !== projectId) {
        throw new AppError(ErrorCodes.REVISION_NOT_FOUND, 'Revision not found', {status: 404});
      }
      if (currentRevision.payloadHash !== input.expectedPayloadHash) {
        throw new AppError(
          ErrorCodes.REVISION_HASH_MISMATCH,
          'Expected revision payload hash does not match current revision',
          {status: 409},
        );
      }

      if (project.status !== 'review_required') {
        throw new AppError(
          ErrorCodes.INVALID_TRANSITION,
          `Project approval cannot be performed from status ${project.status}`,
          {status: 409},
        );
      }

      const approvalMode = APPROVAL_MODES.USER_REVIEWED; // legacy storage compatibility
      const approvalActor = 'chatgpt_mcp_noauth';
      const approvalContext = {semantic: 'external_review_acknowledged'};

      const approvedRevision = repos.revisions.approve({
        projectId,
        revisionId: input.revisionId,
        expectedPayloadHash: input.expectedPayloadHash,
        approvalMode,
        approvalActor,
        approvalContext,
      });

      return {
        project: projectToStatusOutput(repos.projects.get(projectId)),
        revision: approvedRevision,
      };
    },

    startRender(projectId) {
      const project = requireProject(projectId);
      if (project.status !== 'approved') {
        throw new AppError(
          ErrorCodes.INVALID_TRANSITION,
          `Render cannot be started from status ${project.status}`,
          {status: 409},
        );
      }

      const stageId = generatedId(stageIdFactory, 'stageIdFactory');
      const startedAtMs = nowMs();
      const timestamp = new Date(startedAtMs).toISOString();

      const stage = repos.approval.createFirstDescendant({
        id: stageId,
        projectId,
        revisionId: project.currentRevisionId,
        type: 'media_ingest',
        state: 'queued',
        maxAttempts: mediaIngestMaxAttempts,
        availableAtMs: startedAtMs,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      return {
        changed: stage.id === stageId,
        project: projectToStatusOutput(repos.projects.get(projectId)),
        stage,
      };
    },

    retry(projectId) {
      requireProject(projectId);
      const stage = jobs.getCurrentStage(projectId);
      if (!stage) throw new AppError(ErrorCodes.STAGE_NOT_RETRYABLE, 'Stage is not retryable');
      const result = jobs.retry({stageId: stage.id, nowMs: nowMs(), maxActiveProjects});
      return {
        changed: result.changed,
        project: projectToStatusOutput(repos.projects.get(projectId)),
        stage: result.stage,
      };
    },

    cancel(projectId) {
      requireProject(projectId);
      const stage = jobs.getCurrentStage(projectId);
      if (!stage) throw new AppError(ErrorCodes.STAGE_NOT_ACTIVE, 'Stage is not active');
      const result = jobs.cancel({stageId: stage.id, nowMs: nowMs()});
      return {
        changed: result.changed,
        project: projectToStatusOutput(repos.projects.get(projectId)),
        stage: result.stage,
      };
    },
  });
};
