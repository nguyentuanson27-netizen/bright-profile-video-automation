import {
  ResearchProviderError,
  ResearchProviderErrorCodes,
} from '../../providers/research/index.mjs';

const DEFAULT_RESULT = Object.freeze({
  candidates: [
    {
      claim: 'Creator reached 100 followers.',
      url: 'https://research.example/profile',
      title: 'Creator profile',
      publisher: 'Research Example',
      sourceType: 'news',
      sourceRelationship: 'independent',
      category: 'followers',
      value: 100,
      unit: 'followers',
    },
  ],
  sources: [
    {
      url: 'https://research.example/profile',
      title: 'Creator profile',
      publisher: 'Research Example',
    },
  ],
  unavailableSources: [],
});

const clone = (value) => structuredClone(value);

export const createFakeResearchProvider = ({
  mode = 'success',
  result = DEFAULT_RESULT,
  inspectInput,
  gate,
} = {}) => ({
  async research(input) {
    inspectInput?.(input);
    if (gate) await gate;

    if (mode === 'timeout') {
      throw new ResearchProviderError(ResearchProviderErrorCodes.TIMEOUT, 'fake timeout', {retryable: true});
    }
    if (mode === 'rate_limit') {
      throw new ResearchProviderError(ResearchProviderErrorCodes.RATE_LIMIT, 'fake rate limit', {retryable: true});
    }
    if (mode === 'retryable_failure') {
      throw new ResearchProviderError(ResearchProviderErrorCodes.FAILED, 'fake retryable failure', {retryable: true});
    }
    if (mode === 'fatal_failure') {
      throw new ResearchProviderError(ResearchProviderErrorCodes.FAILED, 'fake fatal failure', {retryable: false});
    }
    if (mode === 'inaccessible_source') {
      const value = clone(result);
      value.unavailableSources = [
        ...(value.unavailableSources ?? []),
        {url: 'https://missing.example/source', errorCode: 'SOURCE_UNAVAILABLE'},
      ];
      return value;
    }
    return clone(result);
  },
});
