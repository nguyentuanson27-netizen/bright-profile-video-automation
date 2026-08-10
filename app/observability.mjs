import {performance} from 'node:perf_hooks';
import {Counter, Gauge, Histogram, Registry} from 'prom-client';

const KNOWN_STAGES = new Set(['researching', 'generating', 'rendering']);
const KNOWN_PROVIDERS = new Set(['openai', 'google-tts', 'remotion']);
const KNOWN_OPERATIONS = new Set(['research', 'generation', 'tts', 'render']);
const LOG_FIELDS = new Set([
  'requestId', 'projectId', 'jobId', 'stage', 'method', 'path', 'status', 'attempt',
  'errorCode', 'provider', 'operation', 'outcome', 'durationMs', 'workerId',
]);

const bounded = (value, allowed) => allowed.has(String(value)) ? String(value) : 'other';
const stageLabel = (value) => bounded(value, KNOWN_STAGES);
const providerLabel = (value) => bounded(value, KNOWN_PROVIDERS);
const operationLabel = (value) => bounded(value, KNOWN_OPERATIONS);

const safeLogFields = (fields) => {
  const output = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (!LOG_FIELDS.has(key) || value === undefined || value === null) continue;
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
    output[key] = value;
  }
  return output;
};

export function createObservability({
  queueStats = () => [],
  logger = (event) => console.log(JSON.stringify(event)),
  clock = () => new Date(),
} = {}) {
  if (typeof queueStats !== 'function') throw new TypeError('queueStats must be a function');
  if (typeof logger !== 'function') throw new TypeError('logger must be a function');
  const registry = new Registry();

  const queueDepth = new Gauge({
    name: 'bright_queue_depth',
    help: 'Durable jobs waiting to run by bounded stage.',
    labelNames: ['stage'],
    registers: [registry],
    collect() {
      this.reset();
      for (const stat of queueStats()) this.set({stage: stageLabel(stat.stage)}, Number(stat.queued) || 0);
    },
  });
  const activeJobs = new Gauge({
    name: 'bright_active_jobs',
    help: 'Durable jobs with active leases by bounded stage.',
    labelNames: ['stage'],
    registers: [registry],
    collect() {
      this.reset();
      for (const stat of queueStats()) this.set({stage: stageLabel(stat.stage)}, Number(stat.active) || 0);
    },
  });
  const failedJobs = new Gauge({
    name: 'bright_failed_jobs',
    help: 'Persisted terminal failed jobs by bounded stage.',
    labelNames: ['stage'],
    registers: [registry],
    collect() {
      this.reset();
      for (const stat of queueStats()) this.set({stage: stageLabel(stat.stage)}, Number(stat.failed) || 0);
    },
  });
  const stageDuration = new Histogram({
    name: 'bright_job_stage_duration_seconds',
    help: 'Worker attempt duration by bounded stage and outcome.',
    labelNames: ['stage', 'outcome'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 180, 600, 1800],
    registers: [registry],
  });
  const providerDuration = new Histogram({
    name: 'bright_provider_duration_seconds',
    help: 'External provider operation duration by bounded provider, operation, and outcome.',
    labelNames: ['provider', 'operation', 'outcome'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 180],
    registers: [registry],
  });
  const providerErrors = new Counter({
    name: 'bright_provider_errors_total',
    help: 'External provider errors by bounded provider and operation.',
    labelNames: ['provider', 'operation'],
    registers: [registry],
  });

  const log = (event, fields = {}) => {
    const record = {
      event: String(event),
      timestamp: clock().toISOString(),
      ...safeLogFields(fields),
    };
    try {
      logger(record);
    } catch {
      // Logging must never change request/job correctness.
    }
    return record;
  };

  return Object.freeze({
    contentType: registry.contentType,
    log,

    observeStage({stage, outcome, durationSeconds}) {
      const safeOutcome = outcome === 'success' ? 'success' : 'error';
      stageDuration.observe({stage: stageLabel(stage), outcome: safeOutcome}, Math.max(0, Number(durationSeconds) || 0));
    },

    async observeProvider({provider, operation, run}) {
      if (typeof run !== 'function') throw new TypeError('provider run must be a function');
      const labels = {provider: providerLabel(provider), operation: operationLabel(operation)};
      const started = performance.now();
      try {
        const result = await run();
        const durationSeconds = Math.max(0, performance.now() - started) / 1000;
        providerDuration.observe({...labels, outcome: 'success'}, durationSeconds);
        log('provider.completed', {...labels, outcome: 'success', durationMs: Math.round(durationSeconds * 1000)});
        return result;
      } catch (error) {
        const durationSeconds = Math.max(0, performance.now() - started) / 1000;
        providerDuration.observe({...labels, outcome: 'error'}, durationSeconds);
        providerErrors.inc(labels);
        log('provider.failed', {...labels, outcome: 'error', durationMs: Math.round(durationSeconds * 1000)});
        throw error;
      }
    },

    metrics() {
      return registry.metrics();
    },
  });
}
