# Runbook — Development (Docker)

How to run MasterHand for development **with the same stack as a real
deployment**. Development uses `deploy/docker-compose.yml` (the exact production
services) plus `deploy/docker-compose.dev.yml`, an override that swaps the
compiled BFF for a hot-reloading one.

## 1. Why Docker for development

The agent engine is where development and production used to drift the most:
natively, `opencode serve` runs as your user with no sandbox, on the host's
network and paths. In Docker both run the **same** image and topology:

| Aspect | Development (Docker) | Production |
|---|---|---|
| opencode image | `deploy/opencode.Dockerfile` (pinned, `agent-exec` sandbox, ADR-22) | same |
| Network | `opencode:4096` on the internal network | same |
| Paths | `/data`, `/workspace`, `/workspace/.worktrees` | same |
| Env contract | same variable names | same |
| Previews | bundled `cloudflared`, `PREVIEW_ORIGIN=opencode` | same |
| Runtime user | `node` (uid 1000) with `umask 002` | same |
| BFF | **`tsx watch` from source** (dev only) | compiled `dist/` |
| Web | **Vite dev server + HMR on `:5173`** (dev only) | static build served by the BFF |

The last two rows are the deliberate differences: the runtime topology is
identical, but the BFF and web reload in place while you edit.

## 2. Prerequisites

- Docker Engine with the Compose plugin (`docker compose version`).
- Node 22+ on the host for the tooling, the native clients and the test suites
  (`npm install`, once).

## 3. Start

```bash
npm install
cp deploy/.env.dev.example deploy/.env.dev   # optional: npm run dev creates it on first run
npm run dev                                  # opencode + BFF + web (Vite on :5173)
```

`npm run dev` is an alias of `npm run dev:web`. It builds the images (the first
run is slow) and starts the stack in the foreground; `Ctrl+C` stops it.

| Command | What it does |
|---|---|
| `npm run dev` / `dev:web` | opencode + BFF + Vite (`http://localhost:5173`) |
| `npm run dev:server` | opencode + BFF only (no Vite) |
| `npm run dev:desktop` | the stack **detached**, then Electron on the host against `http://localhost:8787` |
| `npm run dev:mobile` | the stack **detached**, then the Expo dev server on the host |
| `npm run dev:logs` | follow the stack logs |
| `npm run dev:stop` | stop the stack (volumes and data are kept) |

Desktop and mobile cannot run inside a container (they need a GUI/device), so
they run on the host and talk to the containerized BFF. `dev:desktop` and
`dev:mobile` leave the Docker stack running; stop it with `npm run dev:stop`.

### Native fallback

The previous, fully native flow is still available when you do not want Docker
(you need `opencode` v2 on your `PATH`):

```bash
npm run dev:native:web       # scripts/dev.mjs web
npm run dev:native:server
npm run dev:native:desktop
npm run dev:native:mobile
npm run dev:native:stop
```

It uses `apps/server/.env.local` and `127.0.0.1:4096`, **not** `deploy/.env.dev`.

## 4. Configuration

`deploy/.env.dev` uses the **same variable names** as the production
`deploy/.env.example`; only the values differ (plain HTTP, dev secrets). See
that file for the full list. The most relevant ones:

| Variable | Development meaning |
|---|---|
| `MASTERHAND_PASSWORD` | UI password (`dev-password` by default) |
| `SESSION_SECRET` | Cookie/token signing secret |
| `COOKIE_SECURE` | `false` (dev runs over HTTP) |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` (Vite origin) |
| `MASTERHAND_PORT` / `MASTERHAND_DEV_WEB_PORT` | Published BFF / Vite ports |
| `WORKSPACES_DIR` | Host folder mounted as `/workspace` (default `../workspace`) |
| `OPENCODE_SERVER_PASSWORD` | Shared by the BFF and the opencode container |

## 5. State, volumes and hot reload

- **BFF SQLite** → `./data/dev/masterhand.sqlite` (bind mount, easy to inspect).
  It is intentionally separate from the native fallback's
  `./data/masterhand.sqlite`: workspace rows store the workspace root, which is
  `/workspace` in the container but an absolute host path natively, so sharing
  one database between both environments would make each reject the other's
  records.
- **Workspaces** → `./workspace` (bind mount; each workspace you add is a
  subfolder, worktrees under `workspace/.worktrees/`).
- **opencode config/data** → named volumes `masterhand_opencode_config` and
  `masterhand_opencode_data`, exactly like production, so `auth login` persists
  across restarts and `docker compose down` does not wipe it.
- **Source** → `apps/server/src`, `apps/web/src`, `apps/web/index.html`,
  `apps/web/vite.config.ts` and `packages/client-core/src` are bind-mounted on
  top of the image. `tsx watch` and Vite reload on save; dependencies stay in
  the image (no host/container ABI mismatch for `better-sqlite3`).

Adding a dependency requires a rebuild: `npm run dev` (it runs
`docker compose ... build`).

> **Permissions:** the container runs as `node` (uid/gid 1000). The `npm run dev`
> script creates `data/dev` and `workspace` as your user before Compose starts,
> so this only bites when you create them by hand. Fix ownership with:
>
> ```bash
> sudo chown -R 1000:1000 data/dev workspace
> ```

## 6. Authenticate providers (one-time)

opencode keeps credentials in its named volume, so do it once per stack (the
same command as production):

```bash
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml \
  --env-file deploy/.env.dev run --rm opencode auth login
```

## 7. Verify the parity

```bash
# Same services and images as production
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml \
  --env-file deploy/.env.dev ps

# The agent runs sandboxed as `agent` (uid 1001), like production
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml \
  --env-file deploy/.env.dev exec opencode id

# The BFF is healthy
curl -fsS http://localhost:8787/api/health
```

Then open `http://localhost:5173`, log in with `MASTERHAND_PASSWORD`, and edit a
file under `apps/server/src` or `apps/web/src` to confirm the hot reload.

## 8. Troubleshooting

- **Port already in use:** another dev stack (native or Docker) is running.
  `npm run dev:stop` and, for the native one, `npm run dev:native:stop`.
- **`permission denied` writing `./data`:** see the permissions note above.
- **opencode unreachable / 401:** the BFF and the container must share
  `OPENCODE_SERVER_PASSWORD`. It comes from `deploy/.env.dev`; restart the stack
  after changing it.
- **Logs:** `npm run dev:logs` (or `docker compose ... logs -f opencode`).
- **Start over** (deletes the dev database at `data/dev` and the opencode data; workspaces under `workspace/` stay):
  `npm run dev:stop && rm -rf data/dev && docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml --env-file deploy/.env.dev down -v`
