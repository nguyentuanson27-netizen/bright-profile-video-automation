import {randomUUID} from 'node:crypto';
import {AppError} from '../../domain/errors.mjs';
import {assertSchema} from '../../domain/schemas.mjs';

const defaultRevisionId = ({job}) => `revision-${job.id}`;

export function createGenerationProjectService({
  repositories,
  projectStateStore,
  generationProvider,
  jobIdGenerator = randomUUID,
  revisionIdGenerator = defaultRevisionId,
  clock = () => new Date(),
}) {
  if (!repositories?.projects || !repositories?.sources || !repositories?.revisions || !repositories?.jobs) {
    throw new TypeError('generation repositories are required');
  }
  if (!projectStateStore?.enqueueGeneration || !projectStateStore?.setStatus) {
    throw new TypeError('generation project state store is required');
  }
  if (!generationProvider || typeof generationProvider.generate !== 'function') {
    throw new TypeError('generation provider is required');
  }

  return Object.freeze({
    enqueueGeneration(projectId, {jobId: requestedJobId} = {}) {
      const project = repositories.projects.get(projectId);
      if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project was not found', {status: 404});
      const jobId = requestedJobId ?? jobIdGenerator();
      if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > 256) {
        throw new AppError('GENERATION_JOB_ID_INVALID', 'Generation job ID is invalid', {status: 500});
      }

      const existing = repositories.jobs.get(jobId);
      if (existing) {
        if (existing.projectId !== projectId || existing.stage !== 'generating') {
          throw new AppError('GENERATION_JOB_CONFLICT', 'Generation job ID belongs to different work', {status: 409});
        }
        return {project, job: existing};
      }

      const job = projectStateStore.enqueueGeneration({
        projectId,
        jobId,
        now: clock(),
        maxAttempts: 3,
      });
      return {project: repositories.projects.get(projectId), job};
    },

    async execute({job}) {
      if (!job || job.stage !== 'generating') {
        throw new AppError('INVALID_GENERATION_JOB', 'Generation job is invalid', {status: 500});
      }
      const project = repositories.projects.get(job.projectId);
      if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project was not found', {status: 404});

      const revisionId = revisionIdGenerator({job, project});
      const existing = repositories.revisions.get(revisionId);
      if (existing?.status === 'draft') {
        if (project.status === 'generating') {
          projectStateStore.setStatus({projectId: project.id, status: 'review_required', now: clock()});
        }
        return existing;
      }
      if (project.status !== 'generating') {
        throw new AppError('GENERATION_STATE_INVALID', 'Project is not in generation state', {status: 409});
      }

      const allSources = repositories.sources.listByProject(project.id);
      const availableSources = allSources.filter((source) => source.retrievalStatus === 'available');
      if (availableSources.length === 0) {
        throw new AppError('NO_RESEARCH_SOURCES', 'No available research sources can support generation', {status: 409});
      }

      const generation = await generationProvider.generate({
        topic: project.topic,
        sources: availableSources,
        ...(project.input.instructions !== undefined ? {instructions: project.input.instructions} : {}),
        ...(project.input.duration !== undefined ? {duration: project.input.duration} : {}),
        ...(project.input.language !== undefined ? {language: project.input.language} : {}),
      });
      const payload = {
        revisionId,
        projectId: project.id,
        topic: project.topic,
        sources: allSources,
        generation,
      };
      assertSchema('draftRevision', payload);
      const revision = repositories.revisions.saveDraft({projectId: project.id, revisionId, payload});
      projectStateStore.setStatus({projectId: project.id, status: 'review_required', now: clock()});
      return revision;
    },
  });
}
