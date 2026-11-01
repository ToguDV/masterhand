# Runbook — Deployment

How to deploy MasterHand with Docker Compose. TLS is **not** bundled with the project: you choose how to terminate HTTPS. For running the same stack for development (hot-reloading BFF/web), see [`development.md`](development.md).

## 1. Prerequisites

- A host with Docker and Docker Compose.
- A domain (optional but recommended) pointing at the host.
- Model provider API keys available to the opencode container.

## 2. Prepare the environment

```bash
cp deploy/.env.example deploy/.env
```

Fill in `deploy/.env`:

| Variable | Purpose |
|---|---|
| `MASTERHAND_PASSWORD` | Password to access the UI. Production requires **at least 32 bytes** and rejects the example/placeholder values |
| `SESSION_SECRET` | Cookie/token signing secret (`openssl rand -hex 32`), **at least 32 bytes** in production |
| `OPENCODE_SERVER_PASSWORD` | Password for the internal opencode server |
| `SESSION_TTL_HOURS` | Session lifetime in hours (default `720`) |
| `COOKIE_SECURE` | Set `true` behind HTTPS, `false` only for local HTTP. Booleans accept `true/false`, `1/0`, `yes/no`, `on/off` (case-insensitive); any other value aborts boot. `false` logs a plain-HTTP warning |
| `ALLOWED_ORIGINS` | Extra origins allowed on mutating requests (comma-separated) |
| `MASTERHAND_BIND` / `MASTERHAND_PORT` | Host bind address and port for the BFF (default `0.0.0.0:8787`; use `127.0.0.1` when the proxy runs on the host) |
| `WORKSPACES_DIR` | Host directory mounted into opencode as `/workspace` (default `../workspace`). Each workspace you add becomes a subfolder inside it |
| `GIT_COMMIT_NAME` / `GIT_COMMIT_EMAIL` | Author for the initial commit when a workspace is not a git repo yet |
| `PROXY_BODY_LIMIT_MB` | Cap on proxied opencode request bodies (default `10`, range 1–1024) |
| `PROVIDERS_ALLOW_LOOPBACK` | Allow loopback provider-discovery targets (default `false`; set `true` only for a local provider in native/dev, not in Docker) |
| `OPENCODE_VERSION` | Pinned opencode version |

> **Workspaces:** a workspace is a single project folder. From the UI you give it a name and the BFF creates the subfolder under the workspaces root (`/workspace` in the container, i.e. `WORKSPACES_DIR` on the host), isolated from the rest. The BFF and opencode share that mount, so the BFF can create and (optionally) delete the folder while opencode works inside it. Removing a workspace only forgets it in MasterHand unless you tick "also delete files from disk", which deletes the folder and its contents.

> **Git:** a workspace is made its own git root (`git init` + an empty first commit) so opencode resolves its project root there. MasterHand only reads the current branch for the composer viewer; agents commit/push themselves with their own tools and credentials when the task requires it. There is no Finish/PR control.

> **Workspace ownership (agent sandbox, ADR-22):** agent shell commands **and MasterHand-managed dev servers** run as the unprivileged `agent` user (uid 1001) inside the opencode container, while the BFF and the engine run as `node` (uid 1000). The setuid `agent-exec` helper handles both paths: `-c` for opencode's shell setting and `--exec <command> <args>` for managed runs (Compose sets `MANAGED_RUN_LAUNCHER=/usr/local/bin/agent-exec`). It removes supplementary groups, clears the inherited environment and exposes only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `TMPDIR` and a validated `PORT`, so `OPENCODE_SERVER_PASSWORD`, provider keys and `NODE_OPTIONS`/`LD_*` never reach repository code. Both share the `node` group, so `WORKSPACES_DIR` and every workspace subfolder must be writable by gid `1000`. Docker Compose usually creates the directory as root; if you create it by hand:
>
> ```bash
> sudo install -d -o 1000 -g 1000 -m 2775 /path/to/workspace
> # folders created before this change:
> sudo chgrp -R 1000 /path/to/workspace && sudo chmod -R g+ws /path/to/workspace
> ```
>
> This is what lets a broad kill from the agent (`pkill node`, `killall`, …) fail with `EPERM` instead of taking down the engine. A new PTY or child-process path that bypasses `agent-exec` would run as the engine uid — use the helper for every execution path. Run `deploy/agent-exec-drill.sh` inside the container after an image change to prove the uid drop, env scrub and `PORT` allowlist (§6 has the command).
>
> **Engine data permissions:** at every start the opencode image hardens the engine-owned paths: `opencode.db` is pre-created `0600` (WAL/SHM inherit), `log/` and `/home/node/.config/opencode` are `0700`, and `auth.json` is `0600` when present (opencode 2.0.6 keeps credentials in `opencode.db`, not `auth.json`; the container fails closed if an existing engine file cannot be corrected). The BFF (same `node` uid) writes `masterhand-providers.json` `0600`. The `agent` uid can neither read nor write those stores, the config or the logs; `shell/` and `snapshot/` intentionally remain accessible to agent shells.
>
> **Client proxy:** `/api/oc/*` is a method-exact allowlist (see `docs/bff/api.md`); PTY/shell/fs/config/session-create/info/event and the credential list answer `404` before any upstream call. MasterHand's own BFF calls are not affected.
>
> **Engine-side residual:** `#179` isolates shell/PTY code, managed dev servers and the client proxy. opencode's own read tools run as `node` (uid 1000) but are confined by the session `read`/`external_directory` denies on `/proc` and the credential store (#219, lexical match only). Project-level plugins/config are disabled or run as the engine: Compose sets `OPENCODE_CONFIG_PROJECT_DISABLE=true` (#218, below), so a workspace's `.opencode/` dir or `opencode.json(c)` can no longer load plugins, tools, MCP servers, commands or instructions that execute as `node` with access to `opencode.db`. Do not treat `#179` as a full engine sandbox.
>
> **Data directory permissions:** the BFF creates `/data` as `0700` and keeps `masterhand.sqlite`, its `-wal`/`-shm` files, backups and the preview PID file at `0600` (even when they were created by an older release). If a bind mount is not owned by uid 1000, the boot `chmod` fails closed — fix ownership rather than weakening the mode.

## 3. Start the stack

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
```

> **Never reuse a development image in production.** `up -d` without
> `--build`/`pull` reuses whatever image is tagged locally, and the dev overlay
> deliberately runs `NODE_ENV=development` with Vite + `tsx watch`. It now tags
> `masterhand-dev:local`, but a stale `ghcr.io/togudv/masterhand:latest` can
> still exist from older checkouts. Verify the running container:
>
> ```bash
> docker compose -f deploy/docker-compose.yml exec masterhand sh -c 'echo "$NODE_ENV"'
> # production
> docker inspect --format '{{json .Config.Cmd}}' "$(docker compose -f deploy/docker-compose.yml ps -q masterhand)"
> # ["sh","-c","umask 002; exec node apps/server/dist/index.js"]
> ```

The BFF is published on a host port (default `8787`, configurable with `MASTERHAND_PORT`/`MASTERHAND_BIND`). opencode stays on the internal network and publishes no ports.

## 4. Authenticate providers (one-time)

```bash
docker compose -f deploy/docker-compose.yml run --rm opencode auth login
```

Credentials persist in `opencode.db` inside the `opencode_data` volume (2.0.6 has no `auth.json`).

Custom OpenAI-compatible providers added from Settings > Providers are written by the BFF to `~/.config/opencode/masterhand-providers.json` inside the `opencode_config` volume and loaded by opencode through `OPENCODE_CONFIG`; their API keys are stored by opencode's credential system (`opencode.db`), not in that file (see `ARCHITECTURE.md` ADR-30).

The same file carries opencode's `websearch` selection (Settings > Web search). The BFF seeds the keyless source (`tinyfish`) when the key is absent, so agent web searches work without any API key; connecting a key for another source (Exa, Firecrawl, Parallel, Tavily) also stores it in opencode's credential system, never in the file (ADR-34).

### Git safety (workspace roots)

**Security model (2026-10-20):** workspace repositories are untrusted. Every git child runs with a fixed allowlist and a **private empty `HOME`**, `credential.helper=` and `core.sshCommand=` are neutralized, and repo-local credential/filter/hook/fsmonitor config is rejected before the command runs. MasterHand only performs repository-root setup and read-only branch queries; it never commits, pushes or opens PRs. Agents may run their own git commands through the shell guard (only broad process kills and engine credential paths are denied), so credentials they need must be provided to that shell, not to the BFF's git helper.

## 5. Put TLS in front

Point your chosen reverse proxy / tunnel at the BFF port. Examples:

### Caddy (automatic Let's Encrypt)

```caddyfile
masterhand.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1   # no buffering for SSE
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }
}
```

### Nginx (with certbot-managed certificates)

```nginx
server {
    listen 443 ssl;
    server_name masterhand.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;          # required for SSE
        proxy_read_timeout 3600s;
        client_max_body_size 60m;     # chat attachments (ATTACHMENT_MAX_MB + headroom)
    }
}
```

> **Chat attachments are multipart uploads.** The reverse proxy must allow at least `ATTACHMENT_MAX_MB` (50 MB) per request plus multipart headroom; Nginx defaults to 1 MB, so set `client_max_body_size` (Caddy has no default limit). The BFF answers `413 payload_too_large` when its own cap is exceeded.

### Other options

- Traefik with a Let's Encrypt resolver.
- A tunnel (Cloudflare Tunnel, Tailscale Funnel) if you cannot open ports.

Whatever you use, **disable response buffering for SSE** (`/api/events`) and forward `X-Forwarded-For`/`X-Forwarded-Proto`.

## 6. Verify

- `GET https://<your-domain>/api/health` returns `{ "ok": true, "ready": true, "app": "masterhand", "version": "<version>" }`.
- Log in from web, desktop and mobile.
- An external scan shows only the proxy port and SSH open; opencode is unreachable from outside.
- The managed-run sandbox and the engine-data modes hold after an install or upgrade:

```bash
# uid drop, env scrub, PORT allowlist, exit codes (run as root inside opencode)
docker compose -f deploy/docker-compose.yml exec -T --user root opencode \
  sh -s < deploy/agent-exec-drill.sh

# engine-owned paths are owner-only (expect 600/700, owner node)
docker compose -f deploy/docker-compose.yml exec -T opencode sh -c \
  'stat -c "%a %U:%G %n" /home/node/.local/share/opencode/opencode.db /home/node/.local/share/opencode/log /home/node/.config/opencode'
```

- The drill must print `agent-exec drill: OK`; the DB must be `600`, `log/` and the config dir `700`. `shell/` and `snapshot/` are expected to stay readable by the `agent` shells. Run these after `docker compose … up -d --build` (or any image upgrade): an existing container keeps the previous entrypoint and permissions until it is recreated.

## 7. Upgrade and backups

MasterHand targets opencode **v2** (`OPENCODE_VERSION`, pinned in `deploy/.env`). The first time the `opencode` container starts with v2 it migrates the v1 session data in `opencode_data`; the v2 beta warns that data may be reset while contracts stabilize.

```bash
# 0. back up the opencode data volume BEFORE the first v2 start
docker run --rm -v masterhand_opencode_data:/data -v "$PWD":/backup busybox \
  tar czf /backup/opencode_data_v1.tgz -C /data .

# upgrade
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up -d

# follow the v1 → v2 migration from inside the BFF (it speaks basic auth upstream)
curl -s -u "opencode:$OPENCODE_SERVER_PASSWORD" http://127.0.0.1:4096/api/experimental/migration/v1
```

`GET /api/experimental/migration/v1` returns the migration status (`required`, `running`, `done`, …). Sessions and history appear in MasterHand once it reports done; check `docker compose logs opencode` if it fails.

Back up the volumes `masterhand_data`, `opencode_data` and `opencode_config` regularly (not only when upgrading).

Only one BFF may own a data directory: a second instance refuses to boot with `another instance owns <dataDir>` (exit 1). Never delete `masterhand.lock` by hand while an instance might be alive — a crashed holder's lock is reclaimed automatically on the next boot.

### Releases and in-app updates (#131)

Every `v*` tag builds and publishes `ghcr.io/togudv/masterhand:<version>` plus `:latest` (`.github/workflows/release.yml`), with the tag version and the commit SHA baked in as `MASTERHAND_VERSION`/`MASTERHAND_BUILD` (served by `/api/status`, shown in Settings > About). The same tag publishes the opt-in updater image (`ghcr.io/togudv/masterhand-updater`), the signed Android APK + F-Droid repo, and the desktop installers (AppImage/NSIS/DMG) with their `electron-updater` channel files. The release also attaches a `version.json` manifest (`{ version, tag, publishedAt, notes }`); the BFF fetches it through `GET /api/update` and web/desktop show an update notice (upstream release). The web app also shows a stale-bundle notice when the loaded page's build differs from the running server (Reload to pick it up); the desktop shell suppresses it because its UI ships with the installer and updates through `electron-updater`.

- **Pin vs `latest`:** `deploy/docker-compose.yml` defaults to `MASTERHAND_VERSION=latest`. Pin a version in `deploy/.env` (`MASTERHAND_VERSION=0.2.0`) to upgrade on purpose: the notice tells you a release exists, you decide when `pull && up -d` runs. A pinned tag also disables the one-click updater, which needs the floating `latest` tag.
- **One-click updater (opt-in, #134):** set `MASTERHAND_UPDATE_URL=http://updater:8080` and a strong `MASTERHAND_UPDATE_TOKEN` in `deploy/.env`, then start the profile with `docker compose --profile updater up -d`. The BFF snapshots SQLite to `/data/backups/pre-update-*.sqlite`, calls the sidecar, and the sidecar pulls/recreates only the `masterhand` service. The sidecar is the only container with the Docker socket (root-equivalent), has no published ports, and can only act on the one service. See `docs/runbooks/release.md` §6.
- **Backup before upgrading:** the one-click path writes a pre-update backup automatically; for manual upgrades back up `masterhand_data` (SQLite) first — `npm run backup` on the host or a volume snapshot. Migrations are forward-only: an older image cannot read a database a newer one already migrated.
- **Privacy note:** update checks never leave your infrastructure per device. Only the BFF fetches `version.json` from GitHub (once per 12 min cache window, 10 s timeout); clients read the result from `GET /api/update`. Override the manifest location with `UPDATE_MANIFEST_URL` (e.g. a local mirror) when the host has no GitHub access — an unreachable manifest degrades to "no notice", never an error.
- **Desktop:** the shell checks GitHub Releases every 6 hours (and from the native menu), downloads in the background and prompts to restart. Unsigned Windows/macOS builds still install but show SmartScreen/Gatekeeper warnings; macOS auto-update requires a signed build.
- **Android:** server releases and the signed APK ship from the same tag; the APK refreshes the self-hosted F-Droid repo and the Android app notifies through it. Full flow in [`fdroid.md`](fdroid.md).

## 8. Disk headroom, logs and resource limits

Agent workspaces, opencode data and `masterhand_data` (SQLite + audit) share the host disk, so a runaway build or `npm install` can fill it and take SQLite and git down with it. Compose already bounds the most common causes:

- **Logs:** both services use the `json-file` driver capped at `LOG_MAX_SIZE`/`LOG_MAX_FILES` (10 MB × 3 by default). Agent and opencode output can otherwise grow into gigabytes.
- **CPU/memory:** `deploy.resources.limits` caps each service (`MASTERHAND_*_LIMIT`, `OPENCODE_*_LIMIT` in `deploy/.env`; 1 CPU/1 GB and 2 CPU/4 GB by default). A runaway agent build is OOM-killed and restarted instead of taking the BFF/SQLite/host down; raise the opencode limit if a legitimate build needs more.
- **Low-disk warning:** the BFF reports free space on the data volume in `/api/status` (`storage.freeBytes`, `storage.low`) and web/desktop show a banner when it drops below `DISK_LOW_WATERMARK_MB` (512 MB by default; `0` disables).

Monitor the host (for example `df -h`, a cron alert, or your provider's monitoring) and keep at least a few GB free; the in-app warning is a last resort, not a substitute. If you need hard separation, put `WORKSPACES_DIR` on a separate disk/partition from the Docker volumes.

## 9. Troubleshooting: opencode credentials

MasterHand's BFF and `opencode serve` must share the same `OPENCODE_SERVER_PASSWORD`. opencode v2 always protects its API: when started without that env var it generates a password and prints `server password <value>`.

- **Docker (production):** Compose passes `OPENCODE_SERVER_PASSWORD` to the `opencode` service and the BFF reads the same value from `deploy/.env`. Set it once there.
- **Docker (development):** the same Compose stack plus `docker-compose.dev.yml` reads `deploy/.env.dev`; set the password there (see `development.md`).
- **Native fallback (`npm run dev:native:*`):** the script starts opencode itself with the environment from `apps/server/.env.local` and, when no password is configured, generates one shared by both processes. If you start opencode yourself, give the BFF the same value (export it or set it in `apps/server/.env.local`) and restart both; the dev script probes a reused opencode and warns on a mismatch.

Symptoms of a mismatch: every conversation shows a red `opencode rejected MasterHand's credentials…` message, a banner under the header repeats the hint, the sessions list is empty and `/api/status` returns `opencode: { healthy: false, error: "unauthorized" }`. Fix the password and restart both processes (a BFF restart is required: it reads the password at boot).

## 10. Clock and auth notes

Keep the host clock synchronized (NTP / `systemd-timesyncd`). Session cookies and device tokens are HMAC-signed with `iat`/`exp`: a **backward** jump beyond 60 s makes existing tokens fail verification (users sign in again), and a forward jump can expire them early. Tokens whose `iat` is more than 60 s in the future are rejected outright. The login rate limiter is in-memory, so a BFF restart clears its 15-minute window; acceptable for a single-user instance.
