import {AppError} from '../domain/errors.mjs';
import {assertProjectTransition} from '../domain/project.mjs';
import {createRevisionWorkflowStore} from './revision-workflow.mjs';

const toIso = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AppError('INVALID_PROJECT_TIME', 'Project timestamp is invalid', {status: 500});
  }
  return date.toISOString();
};

const mapJob = (row) => row ? {
  id: row.id,
  projectId: row.project_id,
  stage: row.stage,
  status: row.status,
  attempt: row.attempt,
  maxAttempts: row.max_attempts,
  runAfter: row.run_after,
  leaseOwner: row.lease_owner,
  leaseExpiresAt: row.lease_expires_at,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
} : null;

const validateAttempts = (maxAttempts) => {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new AppError('INVALID_JOB_ATTEMPTS', 'Job max attempts is invalid', {status: 500});
  }
};

export function createProjectStateStore(db) {
  const getProject = db.prepare('SELECT id, status FROM projects WHERE id = ?');
  const insertProject = db.prepare(`
    INSERT INTO projects (id, topic, status, input_json, created_at, updated_at)
    VALUES (@id, @topic, 'researching', @inputJson, @now, @now)
  `);
  const updateStatus = db.prepare(`
    UPDATE projects
    SET status = @status, updated_at = @now
    WHERE id = @projectId AND status = @fromStatus
  `);
  const insertJob = db.prepare(`
    INSERT INTO jobs (
      id, project_id, stage, status, attempt, max_attempts, run_after, created_at, updated_at
    ) VALUES (@id, @projectId, @stage, 'queued', 0, @maxAttempts, NULL, @now, @now)
  `);
  const getJob = db.prepare('SELECT * FROM jobs WHERE id = ?');

  const changeStatus = ({projectId, fromStatus, status, now}) => {
    assertProjectTransition(fromStatus, status);
    const changed = updateStatus.run({projectId, fromStatus, status, now});
    if (changed.changes !== 1) {
      throw new AppError('PROJECT_STATE_CONFLICT', 'Project state changed concurrently', {status: 409});
    }
  };

  const createProjectAndEnqueueResearchTransaction = db.transaction(({
    projectId, topic, inputJson, jobId, maxAttempts, now,
  }) => {
    insertProject.run({id: projectId, topic, inputJson, now});
    insertJob.run({
      id: jobId,
      projectId,
      stage: 'researching',
      maxAttempts,
      now,
    });
    return mapJob(getJob.get(jobId));
  });

  const enqueueResearchTransaction = db.transaction(({projectId, jobId, maxAttempts, now}) => {
    const project = getProject.get(projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project was not found', {status: 404});
    changeStatus({projectId, fromStatus: project.status, status: 'researching', now});
    insertJob.run({
      id: jobId,
      projectId,
      stage: 'researching',
      maxAttempts,
      now,
    });
    return mapJob(getJob.get(jobId));
  });

  const enqueueRenderTransaction = db.transaction(({projectId, jobId, initialStatus, maxAttempts, now}) => {
    const project = getProject.get(projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project was not found', {status: 404});
    if (!['tts', 'render_queued'].includes(initialStatus)) {
      throw new AppError('RENDER_INITIAL_STATE_INVALID', 'Render initial state is invalid', {status: 500});
    }
    changeStatus({projectId, fromStatus: project.status, status: 'media_ingest', now});
    changeStatus({projectId, fromStatus: 'media_ingest', status: initialStatus, now});
    insertJob.run({
      id: jobId,
      projectId,
      stage: 'rendering',
      maxAttempts,
      now,
    });
    return mapJob(getJob.get(jobId));
  });

  const revisionWorkflow = createRevisionWorkflowStore(db);

  return Object.freeze({
    createProjectAndEnqueueResearch({projectId, topic, input, jobId, now = new Date(), maxAttempts = 3}) {
      validateAttempts(maxAttempts);
      return createProjectAndEnqueueResearchTransaction.immediate({
        projectId,
        topic,
        inputJson: JSON.stringify(input),
        jobId,
        maxAttempts,
        now: toIso(now),
      });
    },

    enqueueResearch({projectId, jobId, now = new Date(), maxAttempts = 3}) {
      validateAttempts(maxAttempts);
      return enqueueResearchTransaction.immediate({
        projectId,
        jobId,
        maxAttempts,
        now: toIso(now),
      });
    },

    enqueueRender({projectId, jobId, initialStatus, now = new Date(), maxAttempts = 2}) {
      validateAttempts(maxAttempts);
      return enqueueRenderTransaction.immediate({
        projectId,
        jobId,
        initialStatus,
        maxAttempts,
        now: toIso(now),
      });
    },

    setStatus({projectId, status, now = new Date()}) {
      const project = getProject.get(projectId);
      if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project was not found', {status: 404});
      changeStatus({projectId, fromStatus: project.status, status, now: toIso(now)});
      return status;
    },

    ...revisionWorkflow,
  });
}
