# Runbook — Backups and restore

What to back up, how to take a consistent copy of the SQLite database while the BFF is running, and how to restore it. The database (`masterhand_data`) holds devices, workspaces, isolated-session records, preview ports, the audit log and run configs; opencode keeps its own data in `opencode_data`/`opencode_config`, and the actual project files live in `WORKSPACES_DIR`.

## 1. What to back up

| Volume / path | Content | Method |
|---|---|---|
| `masterhand_data` (`/data`) | `masterhand.sqlite` — all MasterHand state | Online backup (below) |
| `opencode_data`, `opencode_config` | opencode sessions, auth and settings | Volume snapshot/tar (see deployment runbook §7) |
| `WORKSPACES_DIR` (`/workspace`) | The projects themselves, including per-session worktrees under `.worktrees/` | Your normal file backup |

## 2. Online database backup (no downtime)

`VACUUM INTO` writes a consistent, compacted snapshot of a live database; WAL contents are included and the result has no `-wal`/`-shm` side files. The destination must **not** exist.

Docker:

```bash
docker compose -f deploy/docker-compose.yml exec masterhand \
  node apps/server/dist/backup.js /data/masterhand.sqlite /data/backup-2026-10-05.sqlite
# copy it out of the volume, then remove the in-volume copy
mkdir -p backups
docker compose -f deploy/docker-compose.yml cp \
  masterhand:/data/backup-2026-10-05.sqlite ./backups/
docker compose -f deploy/docker-compose.yml exec masterhand rm /data/backup-2026-10-05.sqlite
```

Native development:

```bash
npm run backup -w @masterhand/server -- data/masterhand.sqlite /path/to/backups/masterhand-2026-10-05.sqlite
```

Keep the database backups **and** the workspace/opencode backups on a different disk or host; a backup on the same full disk is not a backup. Schedule them with the host cron/systemd timer of your choice.

Cold alternative: stop the stack and tar the whole volume (includes the WAL files):

```bash
docker compose -f deploy/docker-compose.yml stop
docker run --rm -v masterhand_masterhand_data:/data -v "$PWD/backups":/backup busybox \
  tar czf /backup/masterhand_data-2026-10-05.tgz -C /data .
docker compose -f deploy/docker-compose.yml start
```

## 3. Restore

1. Stop the stack: `docker compose -f deploy/docker-compose.yml down`.
2. Replace the database file inside the `masterhand_data` volume (remove any stale `-wal`/`-shm` files next to it):

   ```bash
   docker run --rm -v masterhand_masterhand_data:/data -v "$PWD/backups":/backup busybox \
     sh -c 'rm -f /data/masterhand.sqlite /data/masterhand.sqlite-wal /data/masterhand.sqlite-shm && \
            cp /backup/backup-2026-10-05.sqlite /data/masterhand.sqlite && chown 1000:1000 /data/masterhand.sqlite'
   ```
3. Start the stack again. The BFF runs a `quick_check` at boot and refuses to start with a clear message when the file is corrupt (restore from a newer backup).

After restoring an older database, isolated-session records may point at worktrees that no longer exist; startup reconciliation skips unconfirmed volumes and quarantines rather than deleting uncommitted work (see `docs/past-mistakes.md` rule 11).

## 4. Corruption behavior

- **At boot:** `createSqliteStore` runs `PRAGMA quick_check`. A non-`ok` result (or an unreadable file) logs `[masterhand] storage unavailable at boot` and exits with code 1 — the container stops instead of serving broken requests.
- **At runtime:** SQLite failures surface as `503 { error: "storage_unavailable" }` (instead of opaque 500s) and `/api/status` reports `storage.ok: false`, which the web/desktop banner shows.
