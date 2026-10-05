import { backupDatabase } from "./store.js"

/**
 * Offline-safe database backup CLI: `VACUUM INTO` produces a consistent,
 * compacted copy of a live database.
 *
 *   Docker:  docker compose exec masterhand node apps/server/dist/backup.js \
 *              /data/masterhand.sqlite /data/backup-2026-10-05.sqlite
 *   Native:  npm run backup -w @masterhand/server -- <source.sqlite> <destination.sqlite>
 *
 * The destination must not exist. See docs/runbooks/backups.md.
 */
const [source, destination] = process.argv.slice(2)
if (!source || !destination) {
  console.error("usage: backup <source.sqlite> <destination.sqlite>")
  process.exit(2)
}

try {
  backupDatabase(source, destination)
  console.log(`[masterhand] backup written to ${destination}`)
} catch (error) {
  console.error("[masterhand] backup failed:", error)
  process.exit(1)
}
