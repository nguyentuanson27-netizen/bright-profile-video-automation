const requireMethod = (service, serviceName, method) => {
  if (!service || typeof service[method] !== 'function') {
    throw new TypeError(`${serviceName}.${method} is required`);
  }
  return service[method].bind(service);
};

export function createWorkerHandlers({researchService, generationService, renderService}) {
  const researching = requireMethod(researchService, 'researchService', 'execute');
  const generating = requireMethod(generationService, 'generationService', 'execute');
  const rendering = requireMethod(renderService, 'renderService', 'handleJob');

  return Object.freeze({researching, generating, rendering});
}
