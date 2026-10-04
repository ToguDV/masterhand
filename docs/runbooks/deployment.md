# Runbook — Deployment

How to deploy MasterHand with Docker Compose. TLS is **not** bundled with the project: you choose how to terminate HTTPS.

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
| `MASTERHAND_PASSWORD` | Password to access the UI |
| `SESSION_SECRET` | Cookie/token signing secret (`openssl rand -hex 32`) |
| `OPENCODE_SERVER_PASSWORD` | Password for the internal opencode server |
| `SESSION_TTL_HOURS` | Session lifetime in hours (default `720`) |
| `COOKIE_SECURE` | Set `true` behind HTTPS, `false` only for local HTTP |
| `ALLOWED_ORIGINS` | Extra origins allowed on mutating requests (comma-separated) |
| `MASTERHAND_BIND` / `MASTERHAND_PORT` | Host bind address and port for the BFF (default `0.0.0.0:8787`; use `127.0.0.1` when the proxy runs on the host) |
| `WORKSPACES_DIR` | Host directory mounted into opencode as `/workspace` (default `../workspace`). Each workspace you add becomes a subfolder inside it |
| `GIT_COMMIT_NAME` / `GIT_COMMIT_EMAIL` | Author for commits MasterHand creates in isolated worktrees |
| `GH_TOKEN` / `GITLAB_TOKEN` | Optional credentials so "Finish & PR" can push and open pull requests |
| `OPENCODE_VERSION` | Pinned opencode version |

> **Workspaces:** a workspace is a single project folder. From the UI you give it a name and the BFF creates the subfolder under the workspaces root (`/workspace` in the container, i.e. `WORKSPACES_DIR` on the host), isolated from the rest. The BFF and opencode share that mount, so the BFF can create and (optionally) delete the folder while opencode works inside it. Removing a workspace only forgets it in MasterHand unless you tick "also delete files from disk", which deletes the folder and its contents.

> **Isolated sessions:** when you create a session with the "Isolated" toggle, MasterHand runs it in its own git worktree (`/workspace/.worktrees/<workspace>/<id>`) on branch `masterhand/<slug>-<id>`. The workspace is `git init`-ed automatically if needed. "Finish & PR" commits the worktree, and if the repo has a remote it pushes the branch and opens a PR/MR with `gh`/`glab` when available, otherwise it shows a compare URL.

> **Workspace ownership (agent sandbox, ADR-22):** agent shell commands run as the unprivileged `agent` user (uid 1001) inside the opencode container, while the BFF and the engine run as `node` (uid 1000). Both share the `node` group, so `WORKSPACES_DIR` and every workspace subfolder must be writable by gid `1000`. Docker Compose usually creates the directory as root; if you create it by hand:
>
> ```bash
> sudo install -d -o 1000 -g 1000 -m 2775 /path/to/workspace
> # folders created before this change:
> sudo chgrp -R 1000 /path/to/workspace && sudo chmod -R g+ws /path/to/workspace
> ```
>
> This is what lets a broad kill from the agent (`pkill node`, `killall`, …) fail with `EPERM` instead of taking down the engine.

## 3. Start the stack

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
```

The BFF is published on a host port (default `8787`, configurable with `MASTERHAND_PORT`/`MASTERHAND_BIND`). opencode stays on the internal network and publishes no ports.

## 4. Authenticate providers (one-time)

```bash
docker compose -f deploy/docker-compose.yml run --rm opencode auth login
```

Credentials persist in the `opencode_config` volume.

### Git credentials (isolated sessions)

"Finish & PR" runs inside the **BFF** container. Without credentials it still commits locally and reports the push error in the UI. To enable push + PR:

- **GitHub CLI (bundled):** set `GH_TOKEN` in `deploy/.env` and let `gh` handle the PR. For `git push`, configure the credential helper once per container (or mount a persistent gitconfig):

  ```bash
  docker compose -f deploy/docker-compose.yml exec masterhand gh auth setup-git
  ```

- **Mounted credentials (durable):** mount your git config and store file read-only and add a compose override:

  ```yaml
  services:
    masterhand:
      volumes:
        - ~/.gitconfig:/home/node/.gitconfig:ro
        - ~/.git-credentials:/home/node/.git-credentials:ro
  ```

  with `[credential] helper = store` in `~/.gitconfig`.

- **SSH:** mount `~/.ssh` read-only and set `GIT_SSH_COMMAND="ssh -i /home/node/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new"` for the `masterhand` service.

`glab` is not bundled; extend `deploy/server.Dockerfile` or mount the binary to use GitLab merge requests (without it, MasterHand still returns a compare URL).

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
    }
}
```

### Other options

- Traefik with a Let's Encrypt resolver.
- A tunnel (Cloudflare Tunnel, Tailscale Funnel) if you cannot open ports.

Whatever you use, **disable response buffering for SSE** (`/api/events`) and forward `X-Forwarded-For`/`X-Forwarded-Proto`.

## 6. Verify

- `GET https://<your-domain>/api/health` returns `{ "ok": true }`.
- Log in from web, desktop and mobile.
- An external scan shows only the proxy port and SSH open; opencode is unreachable from outside.

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

## 8. Troubleshooting: opencode credentials

MasterHand's BFF and `opencode serve` must share the same `OPENCODE_SERVER_PASSWORD`. opencode v2 always protects its API: when started without that env var it generates a password and prints `server password <value>`.

- **Docker:** Compose passes `OPENCODE_SERVER_PASSWORD` to the `opencode` service and the BFF reads the same value from `deploy/.env`. Set it once there.
- **Native development:** `npm run dev:*` starts opencode itself with the environment from `apps/server/.env.local` and, when no password is configured, generates one shared by both processes. If you start opencode yourself, give the BFF the same value (export it or set it in `apps/server/.env.local`) and restart both; the dev script probes a reused opencode and warns on a mismatch.

Symptoms of a mismatch: every conversation shows a red `opencode rejected MasterHand's credentials…` message, a banner under the header repeats the hint, the sessions list is empty and `/api/status` returns `opencode: { healthy: false, error: "unauthorized" }`. Fix the password and restart both processes (a BFF restart is required: it reads the password at boot).
