ALTER TABLE projects ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN research_json TEXT;

CREATE INDEX IF NOT EXISTS projects_created_idx ON projects(created_at, id);
