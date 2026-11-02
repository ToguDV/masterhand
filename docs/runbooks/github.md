# GitHub integration for agents

**Status:** shipped 2026-11-02. Applies to the Docker Compose deployment.

MasterHand can give agent shells a GitHub account so they can create remote
branches, push commits, open pull requests and create repositories with `git`
and `gh`. The credential is a **fine-grained personal access token (PAT)**
stored server-side and never returned to a client.

## 1. Create the token

Open <https://github.com/settings/personal-access-tokens/new> and create a
fine-grained token:

- **Resource owner:** your account (or the organization that owns the repos).
- **Repository access:** the repositories the agent should use, or **All
  repositories** if the agent must create new ones.
- **Repository permissions:**
  - `Contents`: read and write (clone, commit, push).
  - `Pull requests`: read and write (open/update PRs).
  - `Metadata`: read (mandatory).
  - `Workflows`: read and write only if the agent edits `.github/workflows`.
- **Account permissions:** `Repository creation`: read and write if the agent
  should create repositories.
- Set an expiry. A leaked token is a repo credential: prefer the smallest
  scope and the shortest practical lifetime.

Classic PATs also work; they need at least the `repo` scope (and `workflow` to
edit Actions). Fine-grained is recommended.

## 2. Connect it

1. Open **Settings → GitHub** in web, desktop or mobile.
2. Paste the token and press **Connect GitHub**.
3. The card shows the GitHub login and whether the agent container received
   the credential files (`injected`). A warning means the token is stored but
   the shared volume is unavailable; see Troubleshooting.

The token is write-only: reopen the section to check the account, replace the
token or disconnect. The status endpoint never returns the secret.

## 3. How it reaches the container

Compose mounts the named volume `agent_config` in both services:

- opencode: `/home/agent/.config`
- BFF: `/agent-config` (`AGENT_CONFIG_DIR=/agent-config`)

The BFF writes, owner-only and group-readable by the `agent` group:

- `git/config` — credential helper (`store --file
  /home/agent/.config/git/credentials`) and a GitHub noreply identity.
- `git/credentials` — the HTTPS credential.
- `gh/hosts.yml` — `github.com` with `git_protocol: https`.

`agent-exec` sets `HOME=/home/agent` and clears the inherited environment, so
`git`/`gh` find these files without exposing the token through an environment
variable. The agent can read the files but not rewrite them; the BFF owns the
directory. Any code the agent runs can read the token — that is the access the
integration is meant to grant. Use a dedicated, least-privilege token.

## 4. Verify

```bash
docker compose -f deploy/docker-compose.yml config >/dev/null
docker compose -f deploy/docker-compose.yml up -d --build opencode masterhand

# Inside the opencode container, as the agent identity:
docker compose -f deploy/docker-compose.yml exec opencode \
  agent-exec -c 'gh auth status && git config --global --get credential.helper'
```

Expected: `gh` reports the connected account and the helper prints
`store --file /home/agent/.config/git/credentials` (the helper is scoped to
the GitHub URL, so query it with `--get-urlmatch`, not a bare `--get`).

A quick end-to-end check from an agent session:

```bash
agent-exec -c 'gh repo view <owner>/<repo> --json name,url'
agent-exec -c 'git ls-remote https://github.com/<owner>/<repo>.git HEAD'
```

## 5. Troubleshooting

- **`injected: false`** — `AGENT_CONFIG_DIR` is unset (native development) or
  the `agent_config` volume is missing. Recreate the stack; the BFF
  re-materializes the files at boot and after every connect.
- **`gh auth status` says not logged in** — check the volume mount and that
  `gh` is the image version pinned by `GH_VERSION`; reopen Settings and press
  **Replace token**.
- **Push asks for a password** — the credential helper file is missing or not
  readable by the `agent` uid. The BFF creates it `0640` under a `0750`
  directory owned by `node:node`.
- **401 from GitHub** — the token expired or was revoked. Create a new one and
  replace it in Settings.
- **403 from GitHub** — the fine-grained token lacks the permission for that
  operation (for example `Workflows` or repository creation).

## 6. Limitations

- `github.com` only; GitHub Enterprise Server is not supported yet.
- Native development keeps the token server-side but cannot inject it into a
  local `opencode serve`; use the Docker stack for agent GitHub access.
- One server-wide account. Switching accounts replaces the token and the files.
- The token is stored in SQLite (`DATA_DIR`, `0600`, data directory `0700`) and
  in the agent config volume. Protect the host and its backups accordingly.
