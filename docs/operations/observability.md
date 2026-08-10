# Observability

## On-call questions

1. Is the app or worker process alive, and is local durable state ready to serve work?
2. Are durable jobs backing up, actively running, or failing in a particular stage?
3. Which worker stage or external provider is slow or failing?
4. Which request or durable job failed, and what stable error code identifies the failure without exposing request/model payloads or secrets?

## Health endpoints

The app exposes:

- `GET /health/live` — process liveness only; it does not call OpenAI, Google TTS, or other providers.
- `GET /health/ready` — verifies the local SQLite connection and that the configured data directory is readable and writable.
- `GET /metrics` — Prometheus text exposition for the app process plus durable queue gauges read from SQLite at scrape time.

The worker exposes the same operations-only routes on `WORKER_OPS_PORT` (default `4181`). The production Compose topology must keep this port private to the internal service network; it is not a public application endpoint.

## Metrics

Durable-state gauges:

- `bright_queue_depth{stage}`
- `bright_active_jobs{stage}`
- `bright_failed_jobs{stage}`

Runtime histograms/counters:

- `bright_job_stage_duration_seconds{stage,outcome}`
- `bright_provider_duration_seconds{provider,operation,outcome}`
- `bright_provider_errors_total{provider,operation}`

Metric labels are intentionally bounded. Project IDs, job IDs, request IDs, raw URLs, error messages, source content, prompts, and model responses must not become metric labels.

## Structured logs

HTTP request and worker-attempt events use stable event names and correlation fields such as `requestId`, `projectId`, `jobId`, `stage`, `attempt`, and stable `errorCode`. Logging is allowlist-based and scalar-only. Do not add authorization headers, request bodies, source excerpts, model payloads, provider response bodies, or secret values to these events.

Provider/stage histograms are process-local runtime metrics. Scrape the app and worker operations endpoints separately; durable queue gauges are visible to both because they are computed from the shared SQLite state at scrape time.
