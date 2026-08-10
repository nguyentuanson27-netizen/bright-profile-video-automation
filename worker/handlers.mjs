const requireMethod = (service, serviceName, method) => {
  if (!service || typeof service[method] !== 'function') {
    throw new TypeError(`${serviceName}.${method} is required`);
  }
  return service[method].bind(service);
};

export function createWorkerHandlers({researchService, generationService, renderService}) {
  const executeResearch = requireMethod(researchService, 'researchService', 'execute');
  const enqueueGeneration = requireMethod(generationService, 'generationService', 'enqueueGeneration');
  const generating = requireMethod(generationService, 'generationService', 'execute');
  const rendering = requireMethod(renderService, 'renderService', 'handleJob');

  const researching = async (context) => {
    const result = await executeResearch(context);
    const {job} = context;
    await enqueueGeneration(job.projectId, {jobId: `generation-${job.id}`});
    return result;
  };

  return Object.freeze({researching, generating, rendering});
}
