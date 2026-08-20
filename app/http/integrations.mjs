import {createHash, randomUUID} from 'node:crypto';
import {AppError, ErrorCodes} from '../../domain/errors.mjs';
import {
  APPROVAL_MODES,
  PROJECT_ORIGINS,
  validateApproveProjectInput,
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

export const createIntegrationsApi = ({
  repos,
  jobs,
  artifactStore,
  dataDir: _dataDir,
  serviceToken,
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

  const assertAuth = (authHeader) => {
    assertValidBearerToken(authHeader, serviceToken, {
      errorCode: ErrorCodes.UNAUTHORIZED,
      errorMessage: 'Unauthorized',
    });
  };

  const assertDownloadAuth = (authHeader, queryToken, artifactId) => {
    if (queryToken && serviceToken && serviceToken.length >= 16) {
      const verified = verifyDownloadToken({token: queryToken, secret: serviceToken, nowMs: nowMs()});
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
      let query = '';
      if (serviceToken && serviceToken.length >= 16) {
        const token = generateDownloadToken({
          projectId: project.id,
          revisionId: project.approvedRevisionId,
          artifactId: outputArtifact.id,
          secret: serviceToken,
          ttlSeconds: 900,
          nowMs: nowMs(),
        });
        query = `?token=${encodeURIComponent(token)}`;
      }
      downloadUrl = `/api/integrations/chatgpt/artifacts/${encodeURIComponent(outputArtifact.id)}/download${query}`;
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
      const incomingFingerprint = hashPayload({
        creator: input.creator,
        topic: input.topic,
        instructions: input.instructions ?? '',
        evidenceBundle: input.evidenceBundle,
      });

      const existing = repos.projects.getByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        const existingFingerprint = hashPayload({
          creator: existing.creator,
          topic: existing.topic,
          instructions: existing.instructions ?? '',
          evidenceBundle: existing.research,
        });

        if (existingFingerprint !== incomingFingerprint) {
          throw new AppError(
            ErrorCodes.IDEMPOTENCY_CONFLICT,
            'Idempotency key was used with different project parameters',
            {status: 409},
          );
        }

        const stage = jobs.getCurrentStage(existing.id);
        return {
          project: projectToStatusOutput(existing),
          stage,
          isExisting: true,
        };
      }

      const projectId = generatedId(projectIdFactory, 'projectIdFactory');
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
      const projectRecord = {
        id: projectId,
        creator: input.creator,
        topic: input.topic,
        instructions: input.instructions ?? '',
        status: 'research_ready',
        origin: PROJECT_ORIGINS.CHATGPT_MCP,
        idempotencyKey: input.idempotencyKey,
        research: input.evidenceBundle,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      repos.projects.createWithSources(projectRecord, sources);

      // Queue durable generation stage
      const started = jobs.startGeneration({
        projectId,
        stageId: generatedId(stageIdFactory, 'stageIdFactory'),
        nowMs: nowMs(),
        maxAttempts: generationMaxAttempts,
      });

      return {
        project: projectToStatusOutput(repos.projects.get(projectId)),
        stage: started.stage,
        isExisting: false,
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

      if (input.mode === APPROVAL_MODES.DELEGATED_E2E) {
        // Server-side safety checks
        if (project.status !== 'review_required') {
          throw new AppError(
            ErrorCodes.DELEGATED_APPROVAL_BLOCKED,
            `Delegated approval blocked: project status is ${project.status}, expected review_required`,
            {status: 409},
          );
        }

        const conflicts = project.research?.conflicts ?? [];
        const unresolved = conflicts.filter((c) => c.status === 'unresolved');
        if (unresolved.length > 0) {
          throw new AppError(
            ErrorCodes.DELEGATED_APPROVAL_BLOCKED,
            `Delegated approval blocked: ${unresolved.length} unresolved evidence conflict group(s) exist`,
            {status: 409, details: {unresolvedConflicts: unresolved.length}},
          );
        }

        const retained = project.research?.stats?.retainedEvidence ?? 0;
        if (retained <= 0) {
          throw new AppError(
            ErrorCodes.DELEGATED_APPROVAL_BLOCKED,
            'Delegated approval blocked: evidence bundle contains no retained evidence',
            {status: 409},
          );
        }

        const unverified = (currentRevision.payload?.claims ?? []).filter((c) => !c.verified && !c.overrideReason);
        if (unverified.length > 0) {
          throw new AppError(
            ErrorCodes.DELEGATED_APPROVAL_BLOCKED,
            `Delegated approval blocked: ${unverified.length} claim(s) are unverified without explicit override`,
            {status: 409},
          );
        }
      }

      const approvedRevision = repos.revisions.approve({
        projectId,
        revisionId: input.revisionId,
        expectedPayloadHash: input.expectedPayloadHash,
        approvalMode: input.mode,
        approvalActor: 'chatgpt_mcp',
        approvalContext: input.delegatedContext ?? null,
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
      const result = jobs.retry({stageId: stage.id, nowMs: nowMs()});
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