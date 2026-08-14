CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  creator TEXT NOT NULL,
  topic TEXT NOT NULL,
  status TEXT NOT NULL,
  current_revision_id TEXT REFERENCES revisions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  approved_revision_id TEXT REFERENCES revisions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  failed_stage TEXT,
  failure_retryable INTEGER CHECK (failure_retryable IN (0, 1)),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sources_project_idx ON sources(project_id, created_at, id);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, revision_no)
);
CREATE INDEX revisions_project_idx ON revisions(project_id, revision_no);

CREATE TRIGGER approved_revision_payload_immutable
BEFORE UPDATE OF payload_json, payload_hash ON revisions
WHEN OLD.approved_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved revision is immutable');
END;

CREATE TRIGGER approved_revision_approval_immutable
BEFORE UPDATE OF approved_at ON revisions
WHEN OLD.approved_at IS NOT NULL AND NEW.approved_at IS NOT OLD.approved_at
BEGIN
  SELECT RAISE(ABORT, 'approved revision is immutable');
END;

CREATE TRIGGER approved_revision_delete_immutable
BEFORE DELETE ON revisions
WHEN OLD.approved_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved revision is immutable');
END;

CREATE TABLE stages (
  id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT REFERENCES revisions(id) ON DELETE RESTRICT,
  stage_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at_ms INTEGER NOT NULL DEFAULT 0,
  current_claim_token TEXT,
  lease_expires_at_ms INTEGER,
  progress_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX stages_runnable_idx ON stages(state, available_at_ms, lease_expires_at_ms, created_at);
CREATE INDEX stages_project_revision_idx ON stages(project_id, revision_id, stage_type);

CREATE TRIGGER stage_cancel_cancels_project
AFTER UPDATE OF state ON stages
WHEN NEW.state = 'cancelled' AND OLD.state <> 'cancelled'
BEGIN
  UPDATE projects
  SET status = 'cancelled', updated_at = NEW.updated_at
  WHERE id = NEW.project_id;
END;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  claim_token TEXT NOT NULL UNIQUE,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'lost')),
  started_at_ms INTEGER NOT NULL,
  lease_expires_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  UNIQUE(stage_id, attempt_no)
);
CREATE INDEX attempts_stage_idx ON attempts(stage_id, attempt_no);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT REFERENCES revisions(id) ON DELETE RESTRICT,
  stage_id TEXT REFERENCES stages(id) ON DELETE SET NULL,
  attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  mime_type TEXT,
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  sha256 TEXT,
  is_authoritative INTEGER NOT NULL DEFAULT 0 CHECK (is_authoritative IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX artifacts_authoritative_kind_idx
  ON artifacts(project_id, revision_id, kind)
  WHERE is_authoritative = 1;
