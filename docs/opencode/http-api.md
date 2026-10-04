# opencode HTTP API (subset for MasterHand)

Verified on **2026-10-01** against a live **opencode v2.0.6** server and the generated types from [`@opencode/client@2.0.21`](https://www.npmjs.com/package/@opencode/client). The OpenAPI 3.1 contract is published by the server itself at `/doc`.

> MasterHand targets opencode **v2 only**. The v1 server API (`/session`, `/global/event`, `x-opencode-directory`, `prompt_async`, per-prompt `system`, …) is not used anymore.

## Authentication

- HTTP basic auth with `OPENCODE_SERVER_PASSWORD` (default user `opencode`, configurable with `OPENCODE_SERVER_USERNAME`). Unchanged from v1.
- Only the BFF knows these credentials and injects them when proxying. Clients never see them.
- `opencode serve --hostname 0.0.0.0 --port 4096` runs the same server used in Docker.

## Endpoints MasterHand uses

Everything lives under `/api/*`. The BFF proxy strips its own `/api/oc` prefix, so `client-core` calls opencode through `/api/oc/api/...` (e.g. `/api/oc/api/info` → `GET /api/info`).

### Health, locations and events

| Method | Route | Usage in MasterHand |
|---|---|---|
| `GET` | `/api/info` | Health/version (`{ version, pid, urls, paths }`); replaces `/global/health` |
| `GET` | `/api/event` | SSE stream of every event (**the one MasterHand uses**); replaces `/global/event` |
| `GET` | `/api/location` | Resolve a location (not used directly: sessions carry theirs) |

### Sessions

| Method | Route | Usage in MasterHand |
|---|---|---|
| `GET` | `/api/session` | List sessions. Query: `directory`, `limit`, `order`, `search`, `parentID`, `cursor`; responds `{ data, cursor: { previous, next } }` (newest 50 by default). A cursor cannot be combined with `order` |
| `POST` | `/api/session` | Create session; body `{ title?, agent?, model?, location: { directory } }`; responds `{ data: SessionInfo }` |
| `GET` | `/api/session/:id` | Session detail (`{ data }`) |
| `PATCH` | `/api/session/:id` | Rename / metadata / permissions |
| `DELETE` | `/api/session/:id` | Delete session and its children (session id resolves the location, no `directory` needed) |
| `GET` | `/api/session/active` | Session ids running right now (`{ data: { [sessionID]: { type: "running" } } }`) |
| `GET` | `/api/session/:id/message` | History. Query: `limit`, `order` (`asc`/`desc`), `cursor`, `type`; responds `{ data: Session.Message.Info[], cursor }` |
| `POST` | `/api/session/:id/prompt` | Send a prompt. Body `{ text, files?, agents?, skills?, metadata?, delivery?, resume? }`; responds `{ data: Session.Inbox.User }` |
| `POST` | `/api/session/:id/command` | Run a slash command. Body `{ name, text, agents?, ... }`; the argument text is the rest of the message. `204`; `404 CommandNotFoundError` for an unknown command |
| `POST` | `/api/session/:id/fork` | Fork a session with its context; body `{ before?: messageID }`; responds `{ data: SessionInfo }` (with `fork: { sessionID, boundary }`). **MasterHand uses it for `/btw` side questions**, then deletes the fork |
| `DELETE` | `/api/session/:id` | Delete session and its children (session id resolves the location, no `directory` needed). MasterHand deletes the `/btw` fork this way |
| `POST` | `/api/session/:id/interrupt` | Stop the running turn; responds `{ interrupted: boolean }` |
| `POST` | `/api/session/:id/agent` | Switch agent; body `{ agent: string }`; `204` |
| `POST` | `/api/session/:id/model` | Switch model; body `{ model: { id, providerID, variant? } }`; `204` |
| `POST` | `/api/session/:id/synthetic` | Add a synthetic message without executing (`resume: false`) |
| `PUT` | `/api/experimental/session/:id/instructions/entries/:key` | Add/update a session instruction entry; body `{ value: JsonValue }`; `204`. Entries become part of the model's system context (`session.instructions.updated`). **MasterHand uses key `masterhand.preview`** |
| `DELETE` | `/api/experimental/session/:id/instructions/entries/:key` | Remove an instruction entry |

### Processes (PTY)

| Method | Route | Usage in MasterHand |
|---|---|---|
| `POST` | `/api/pty` | Create a process; body `{ command, args?, cwd?, title?, env? }`; responds `{ location, data: { id, pid, status, … } }`. MasterHand starts the workspace's dev server with it (title `masterhand:<sessionID>`, `{port}` substituted in `args`, `PORT` in `env`). Verified against 2.0.21: `env` and `cwd` are honored and the command is spawned without a shell |
| `GET` | `/api/pty` | List PTYs of a location (`?location[directory]=…`), with `id`, `title`, `status`, `pid`. Used to adopt a still-running dev server after a BFF restart |
| `DELETE` | `/api/pty/:ptyID` | Terminate the process; `204`. Verified: kills the whole process tree (children included), so a dev server started through `npm`/`bash` dies completely |

### Permissions

| Method | Route | Usage in MasterHand |
|---|---|---|
| `GET` | `/api/permission/request` | Pending requests; query `location[directory]`; responds `{ location, data: Permission.Request[] }` (used to reconcile missed events) |
| `GET` | `/api/session/:id/permission` | Pending requests for one session (`{ data }`) |
| `POST` | `/api/session/:id/permission/:requestID/reply` | Answer; body `{ decision: "once" \| "always" \| "reject", message? }`; `204` |
| `GET` | `/api/permission/saved` | Persisted rules (after an `always` answer) |

### Agents, models, providers and config

| Method | Route | Usage |
|---|---|---|
| `GET` | `/api/agent` | Agents (`{ location, data: Agent.Info[] }`); `id`, `name`, `mode` (`primary`/`subagent`/`all`), `hidden` |
| `GET` | `/api/model` | Model catalog (`{ location, data: Model.Info[] }`); each model has `id`, `providerID`, `name`, `variants: Model.Variant[]` and `enabled` |
| `GET` | `/api/model/default` | Server default model (`{ location, data: Model.Info \| null }`) |
| `GET` | `/api/provider` | Providers (`{ location, data: Provider.Info[] }`), no nested models |
| `GET` | `/api/command` | Slash commands (`{ location, data: Command.Info[] }`); each item only has `name` and `description` — no argument metadata |
| `GET` | `/api/config` | Configuration documents (`ConfigEntry[]`). Used by the BFF to read each command's `template` and derive argument hints (`$ARGUMENTS`, `$1..$N`); the raw config is never sent to clients |

## Location (working directory) model

opencode v2 resolves a **location** instead of the old `directory` header:

- Location-scoped routes (`/api/agent`, `/api/model`, `/api/model/default`, `/api/provider`, `/api/permission/request`, `/api/config`, …) take `?location[directory]=/abs/path`.
- `GET /api/session` takes the flat `?directory=/abs/path`.
- `POST /api/session` takes `location: { directory }` in the **body**.
- Session-scoped routes (`/api/session/:id/...`) resolve the location from the session id: no directory/header needed.
- The `x-opencode-directory` header no longer exists.

`@opencode/client` serializes all of this; `client-core` never hand-builds the query.

## Messages and prompts

- `Session.Message.Info` is a discriminated union (`user`, `assistant`, `system`, `synthetic`, `skill`, `shell`, `compaction`, `idle`, `agent-switched`, `model-switched`, `location-switched`). Only `user` and `assistant` are chat content.
- Assistant content lives in `content: Array<{ type: "text" } | { type: "reasoning" } | { type: "tool" }>` (there is no separate `parts` array).
  - Tool parts: `{ type: "tool", id, name, executed?, state, time }` where `state` is `streaming | running | completed | error`; completed results are `content: Tool.Content[]` (`text` or `file`).
  - Assistant messages carry `agent`, `model: Model.Ref`, `cost`, `tokens`, `finish` and an optional structured `error`.
- User messages carry `text` (no parts), plus optional `files`/`agents`/`skills`.
- **The prompt body has no `model`, `agent`, `variant` or `system`**: model/agent changes go through their own endpoints (MasterHand only switches when the value actually changed, because every switch records a `*-switched` message), and `variant` travels inside `model: { id, providerID, variant? }`.
- `SessionStatus` is `{ type: "idle" } | { type: "busy" } | { type: "retry", attempt, message, next, action? }`.

## JavaScript client

- Package: **`@opencode/client@2.0.21`** (generated Promise client; browser-compatible). The v1 `@opencode-ai/sdk` is not used.
- `OpenCode.make({ baseUrl, headers?, fetch? })`. `baseUrl` keeps its path prefix and requests repeat `/api/...`, so pointing it at the BFF proxy works: `https://masterhand.example/api/oc/` → `/api/oc/api/session`.
- `client-core` wraps the injected `fetch` to add the device Bearer token, keep same-origin cookies and turn failures into its own `ApiError` (unwrapping the generated client's transport error).
- Streaming: `client.event.subscribe()` exists, but MasterHand keeps its own single-upstream EventHub (`/api/events`) for reconnection/watchdog and multi-device fan-out.

## Integration notes

- `POST /api/session/:id/prompt` returns immediately with the admitted inbox item; progress arrives over SSE (`session.text.delta`, …) — the recommended UI flow.
- Sessions persist the `agent` and `model` they last ran with; `GET /api/session` returns them, so clients can preselect the last used model.
- Histories are paginated with an opaque cursor. `client-core` walks `cursor.next` (`order=desc`, 200 per page, 50 pages max) so the page cap drops old history instead of the newest messages, then reverses the pages to chronological order. Verified on a live 2.0.21 server: `order` is only accepted on the first page and the cursor pages keep that same order (both `asc` and `desc`).
- In Docker it runs as the `opencode` Compose service listening on `0.0.0.0:4096` inside the internal network (no published ports), with `OPENCODE_SERVER_PASSWORD` in `.env`. Image: `npm install -g @opencode/cli@<version>` (`deploy/opencode.Dockerfile`).
- v2 migrates v1 session data on first start (the server exposes `GET /api/experimental/migration/v1` to follow the progress). Back up the `opencode_data` volume before upgrading.
