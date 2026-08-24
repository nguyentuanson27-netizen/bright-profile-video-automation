ALTER TABLE projects ADD COLUMN origin TEXT NOT NULL DEFAULT 'standalone';
ALTER TABLE projects ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS projects_idempotency_key_idx
  ON projects(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE revisions ADD COLUMN approval_mode TEXT;
ALTER TABLE revisions ADD COLUMN approval_actor TEXT;
ALTER TABLE revisions ADD COLUMN approval_context_json TEXT;

CREATE TRIGGER IF NOT EXISTS approved_revision_metadata_immutable
BEFORE UPDATE OF approval_mode, approval_actor, approval_context_json ON revisions
WHEN OLD.approved_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved revision is immutable');
END;