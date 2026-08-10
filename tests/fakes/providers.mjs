import {AppError} from '../../domain/errors.mjs';
import {createGenerationProvider} from '../../providers/generation/index.mjs';
import {createResearchProvider} from '../../providers/research/index.mjs';

const failureFor = (mode) => {
  if (mode === 'timeout') {
    return new AppError('PROVIDER_TIMEOUT', 'Provider request timed out', {status: 504, retryable: true});
  }
  if (mode === 'rate-limit') {
    return new AppError('PROVIDER_RATE_LIMITED', 'Provider rate limit reached', {status: 429, retryable: true});
  }
  if (mode === 'retryable-error') {
    return new AppError('PROVIDER_TEMPORARY_FAILURE', 'Provider temporarily unavailable', {status: 502, retryable: true});
  }
  if (mode === 'fatal-error') {
    return new AppError('PROVIDER_FAILURE', 'Provider request failed', {status: 502, retryable: false});
  }
  return null;
};

export function createFakeResearchProvider({mode = 'success'} = {}) {
  return createResearchProvider({
    search: async () => {
      const failure = failureFor(mode);
      if (failure) throw failure;
      if (mode === 'malformed') return {candidates: [{url: 'file:///etc/passwd', sourceId: 'invented'}]};

      return {
        candidates: [{
          url: 'https://example.com/creator',
          platform: 'example.com',
          title: 'Deterministic creator source',
          sourceType: 'search-result',
          discoveryStatus: mode === 'inaccessible' ? 'unavailable' : 'discovered',
        }],
      };
    },
  });
}

export function createFakeGenerationProvider({mode = 'success'} = {}) {
  return createGenerationProvider({
    generate: async ({topic, sources, duration = 6}) => {
      const failure = failureFor(mode);
      if (failure) throw failure;
      if (mode === 'malformed') return {not: 'the generation contract'};

      const sourceId = sources[0]?.sourceId;
      const supported = Boolean(sourceId);
      return {
        researchSummary: `Deterministic summary for ${topic}.`,
        claims: [{
          id: 'claim-1',
          text: 'Deterministic claim.',
          sourceIds: supported ? [sourceId] : [],
          status: supported ? 'supported' : 'unverified',
        }],
        script: `Deterministic profile script for ${topic}.`,
        voiceover: {
          chunks: [{id: 'hero', start: 0, duration, text: `Profile of ${topic}.`}],
        },
        project: {
          duration,
          creatorName: topic,
          scenes: [{id: 'hero', type: 'hero', start: 0, duration}],
        },
      };
    },
  });
}
