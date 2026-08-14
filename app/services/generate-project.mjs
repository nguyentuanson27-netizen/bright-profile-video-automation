import {validateDraft} from '../../domain/schemas.mjs';
import {
  GenerationProviderError,
  GenerationProviderErrorCodes,
  assertGenerationProvider,
  validateGenerationProviderResult,
} from '../../providers/generation/index.mjs';

const MAX_SOURCES = 200;
const MAX_EVIDENCE = 200;

const sourceTitle = (source) => {
  const value = source?.payload?.title ?? source?.payload?.publisher ?? source?.url;
  return typeof value === 'string' ? value.slice(0, 1000) : source.url;
};

const buildGenerationInput = (project, sourceRows) => {
  if (!project?.research || !Array.isArray(project.research.evidence)) {
    throw new GenerationProviderError(GenerationProviderErrorCodes.INVALID_INPUT, 'Normalized research is required', {retryable: false});
  }
  const available = sourceRows.filter((source) => source.status === 'available').slice(0, MAX_SOURCES);
  if (available.length === 0) {
    throw new GenerationProviderError(GenerationProviderErrorCodes.INVALID_INPUT, 'At least one available source is required', {retryable: false});
  }
  const byUrl = new Map();
  for (const source of available) {
    byUrl.set(source.url, source.id);
    try { byUrl.set(new URL(source.url).href, source.id); } catch { /* already application-owned validated data */ }
  }
  const evidence = [];
  for (const item of project.research.evidence.slice(0, MAX_EVIDENCE)) {
    const sourceIds = [];
    for (const source of item.sources ?? []) {
      const id = byUrl.get(source.url) ?? byUrl.get(source.canonicalUrl);
      if (id && !sourceIds.includes(id)) sourceIds.push(id);
    }
    if (sourceIds.length === 0) {
      throw new GenerationProviderError(
        GenerationProviderErrorCodes.INVALID_INPUT,
        'Normalized evidence is missing application-owned source provenance',
        {retryable: false},
      );
    }
    evidence.push({
      id: item.id,
      claim: item.claim,
      confidence: item.confidence,
      conflictGroupId: item.conflictGroupId ?? null,
      sourceIds,
    });
  }
  if (evidence.length === 0) {
    throw new GenerationProviderError(GenerationProviderErrorCodes.INVALID_INPUT, 'At least one normalized evidence item is required', {retryable: false});
  }
  return {
    creator: project.creator,
    topic: project.topic,
    instructions: project.instructions ?? '',
    sources: available.map((source) => ({id: source.id, url: source.url, title: sourceTitle(source)})),
    evidence,
  };
};

const requireHumanVerification = (draft) => ({
  ...draft,
  claims: draft.claims.map(({overrideReason: _overrideReason, ...claim}) => ({
    ...claim,
    verified: false,
  })),
});

export const createGenerationService = ({provider} = {}) => {
  const generationProvider = assertGenerationProvider(provider);
  return Object.freeze({
    async generate({project, sources} = {}) {
      if (!project || typeof project !== 'object') throw new TypeError('project is required');
      if (!Array.isArray(sources)) throw new TypeError('sources are required');
      const input = buildGenerationInput(project, sources);
      let result;
      try {
        result = await generationProvider.generate(input);
      } catch (error) {
        if (error instanceof GenerationProviderError) throw error;
        throw new GenerationProviderError(GenerationProviderErrorCodes.FAILED, 'Generation provider failed', {retryable: false});
      }
      const draft = validateGenerationProviderResult(result);
      validateDraft(draft, {knownSourceIds: input.sources.map(({id}) => id)});
      if (draft.creatorName !== project.creator) {
        throw new GenerationProviderError(GenerationProviderErrorCodes.INVALID_RESULT, 'Generated creator name does not match the project', {retryable: false});
      }
      const reviewDraft = requireHumanVerification(draft);
      validateDraft(reviewDraft, {knownSourceIds: input.sources.map(({id}) => id)});
      return reviewDraft;
    },
  });
};

export const createGenerationStageHandler = ({repos, generationService} = {}) => {
  if (!repos?.projects || !repos?.sources) throw new TypeError('repositories are required');
  if (!generationService || typeof generationService.generate !== 'function') throw new TypeError('generationService is required');
  return async (claim, context) => {
    if (!claim?.projectId) throw new TypeError('generation claim projectId is required');
    if (!context || typeof context.commitGeneration !== 'function') throw new TypeError('fenced generation commit is required');
    const project = repos.projects.get(claim.projectId);
    if (!project) throw new GenerationProviderError(GenerationProviderErrorCodes.INVALID_INPUT, 'Generation project no longer exists', {retryable: false});
    const draft = await generationService.generate({project, sources: repos.sources.list(claim.projectId)});
    context.commitGeneration(draft);
  };
};
