# Storage lifecycle and backup

## Retention defaults

- Completed heavy artifacts (`approved-media`, TTS audio, rendered MP4) are eligible for cleanup after 30 days.
- Failed, cancelled, and unapproved transient heavy artifacts are eligible after 7 days.
- Project rows, source metadata, approved revisions, and media manifests are retained.
- Files belonging to projects with queued/running jobs are protected. Terminal work directories become eligible after the transient retention window.

Override the defaults with:

```text
COMPLETED_ARTIFACT_RETENTION_DAYS=30
TRANSIENT_ARTIFACT_RETENTION_DAYS=7
```

## Disk guard

The app and worker inspect free space on `DATA_DIR` before remote media ingest, TTS generation, and Remotion rendering.

Defaults:

```text
DISK_WARNING_FREE_PERCENT=25
DISK_HARD_FREE_PERCENT=15
DISK_HARD_FREE_GIB=20
```

New expensive media work is blocked when free capacity is below 15% **or** below 20 GiB. `/metrics` exposes unlabeled `bright_disk_free_bytes`, `bright_disk_free_ratio`, `bright_disk_warning`, and `bright_disk_blocked` gauges on the app and worker operations endpoints.

## Cleanup

Preview cleanup candidates; this is the safe default and deletes nothing:

```bash
npm run storage:cleanup
```

Apply the same policy after reviewing the dry-run output:

```bash
npm run storage:cleanup -- --apply
```

Cleanup validates every candidate path under `DATA_DIR` before deletion and rechecks persistent job/project state immediately before removing each candidate.

## Backup

Create a SQLite online backup plus retained media manifests under `DATA_DIR/backups`:

```bash
npm run storage:backup
```

Use a deterministic operator-supplied name when needed:

```bash
npm run storage:backup -- --name before-deploy-20260810
```

Backup names are restricted to a single safe path segment. An existing backup directory is never overwritten. A failed backup removes its temporary directory rather than publishing a partial backup as complete.

## Restore verification

Before relying on a backup for a risky deployment, copy the backup directory to an isolated environment and open its `app.sqlite` with the same or compatible application version. Verify that approved revisions and sources are readable and that required manifest files exist before changing production state.
