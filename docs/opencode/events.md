# opencode server SSE events

Verified on **2026-10-01** against a live **opencode v2.0.6** server and the generated types of [`@opencode/client@2.0.21`](https://www.npmjs.com/package/@opencode/client). Form events (the `question` tool) re-verified on **2026-10-03** against a live **opencode v2.0.21** server.

## Connection

| Endpoint | Scope | Usage |
|---|---|---|
| `GET /api/event` | All server locations | **The one MasterHand uses** |

- Each SSE frame is `data: <json>` where the JSON is one event object:
  `{ id, created?, type, location?: { directory }, data, durable?: { aggregateID, seq, version } }`.
  MasterHand's hub parses the JSON and re-emits the object unchanged on `/api/events` (see `docs/bff/api.md`).
- `location.directory` tells which project the event belongs to; session-scoped events also carry `data.sessionID`.
- The first event in the stream is `server.connected`; heartbeats are SSE comments (`: heartbeat`) and must be ignored. Re-verified on **2026-10-05** against a live **opencode v2.0.21**: one `: heartbeat` comment arrives **every 15 s** exactly, so MasterHand's hub treats any raw byte (comments included) as liveness and reconnects a socket that goes silent past 45 s.
- **No replay guarantee**: if the connection drops, lost events are not re-emitted. Clients refetch history on reconnect (see `ARCHITECTURE.md` §4.5).
- There is no `sync` stream anymore; every event is delivered once.

## Events MasterHand consumes

| Event | `data` (verified) | Usage |
|---|---|---|
| `server.connected` | `{}` | Connection indicator; **reconnection recovery**: opencode (re)connected, so clients refetch (missed events, failed catalogs/messages) |
| `agent.updated` / `model.updated` / `provider.updated` / `models-dev.refreshed` | `{}` | Catalog hot-reload (config edits, models.dev refresh): refresh the composer agent/model lists |
| `session.created` | `{ sessionID, projectID, location, parentID?, title?, agent?, model? }` | Add session to the list |
| `session.renamed` | `{ sessionID, title }` | Update title in the list |
| `session.metadata.updated` | `{ sessionID, metadata }` | Refresh session metadata |
| `session.deleted` | `{ sessionID }` | Remove from the list |
| `session.agent.selected` / `session.model.selected` | `{ sessionID, agent? / model? }` | Refresh the session's remembered selection |
| `session.permissions` | `{ sessionID, permissions }` | Session permission ruleset changed |
| `session.status` | `{ sessionID, status: SessionStatus }` | Working / idle / retrying indicator |
| `session.execution.started` | `{ sessionID }` | Turn started (client marks busy and refreshes messages) |
| `session.execution.succeeded` | `{ sessionID }` | Turn finished successfully |
| `session.execution.interrupted` | `{ sessionID }` | User aborted the turn |
| `session.execution.failed` | `{ sessionID, error: Session.StructuredError }` | **In-app notification: agent error** (`error.type === "MessageAbortedError"` is ignored) |
| `session.retry.scheduled` | `{ sessionID, assistantMessageID, attempt, at, error }` | Retry indicator |
| `session.idle` | `{ sessionID }` | Session went idle |
| `session.step.ended` | `{ sessionID, assistantMessageID, finish, cost, tokens, snapshot?, files? }` | Step usage (cost/tokens) live |
| `session.text.started` / `.delta` / `.ended` | `{ sessionID, assistantMessageID, ordinal, delta? / text? }` | **Live assistant text streaming** |
| `session.reasoning.started` / `.delta` / `.ended` | `{ sessionID, assistantMessageID, ordinal, delta? / text? }` | **Live reasoning streaming** |
| `session.tool.input.started` | `{ sessionID, assistantMessageID, id, name }` | Tool card appears (input streaming) |
| `session.tool.input.delta` / `.input.ended` | `{ …, id, delta } / { …, id, text }` | Streamed tool input (raw JSON → parsed on end) |
| `session.tool.called` | `{ sessionID, assistantMessageID, id, input, executed, state? }` | Tool running |
| `session.tool.progress` | `{ …, id, metadata }` | Tool progress metadata |
| `session.tool.success` | `{ …, id, content: Tool.Content[], metadata?, executed }` | Tool completed (result `content`) |
| `session.tool.failed` | `{ …, id, error, content?, metadata? }` | Tool failed |
| `permission.asked` | `Permission.Request` (see below) | **Approval modal + in-app notification** |
| `permission.replied` | `{ sessionID, requestID, reply }` | Sync the answer across devices |
| `form.created` | `{ form: Form.Info }` (see below) | **Agent question**: inline answer card for the `question` tool |
| `form.replied` | `{ id, sessionID, answer }` | Mark the question answered (this or another device) |
| `form.cancelled` | `{ id, sessionID }` | Mark the question dismissed |
| `session.usage.updated` | `{ sessionID, cost, tokens }` | Session totals |

Not consumed yet (present in v2): `session.compaction.*`, `session.shell.*`, `session.revert.*`, `session.skill.*`, `session.inbox.*`, `filesystem.changed`, `worktree.*`, `vcs.branch.updated`, `pty.*`, `mcp.*`, `installation.*`, `tui.*`.

## Streaming model

- Text and reasoning parts are identified by `assistantMessageID` + `ordinal`; the ordinal numbers parts **per kind** (text parts 0, 1, … independently from reasoning parts), so projections and events must use the same per-kind counter as the part id. Deltas append and the matching `*.ended` carries the final text.
- Tool parts are identified by their call `id`; the tool name only arrives in `session.tool.input.started`, so a tool event that appears first is shown with the call id until the name arrives.
- `session.step.ended` closes a step with authoritative `cost`/`tokens`; `session.execution.succeeded` (or `failed`/`interrupted`) ends the turn, after which the client refetches `GET /api/session/:id/message` and replaces its live state with the projected history.
- While a step is open, the projection **includes the in-flight assistant message but omits its accumulated text** — verified against a live 2.0.21 server: polls during streaming return `content` with empty text, and the full text appears only when `time.completed` is set. A client that refetches mid-step must therefore preserve its live text/reasoning parts (MasterHand's `mergeLiveMessages`); completed messages are authoritative projections.

## Referenced types

### `Permission.Request` (`permission.asked`)

```ts
{
  id: string
  sessionID: string
  action: string                 // e.g. "shell", "edit", "websearch", "subagent"
  resources: string[]            // affected commands/paths/globs
  save?: string[]                // rules the "always" answer would persist
  metadata?: Record<string, unknown>
  source?: { type: "tool", messageID: string, id: string }
  message?: string
}
```

Real captured event:

```json
{
  "id": "evt_…",
  "created": 1790849…,
  "type": "permission.asked",
  "location": { "directory": "/workspace/my-app" },
  "data": {
    "id": "per_…",
    "sessionID": "ses_…",
    "action": "shell",
    "resources": ["ls"],
    "save": ["ls *"]
  }
}
```

Answer with `POST /api/session/:id/permission/:requestID/reply` and body `{ "decision": "once" | "always" | "reject" }`.

### Question forms (`form.created` / the `question` tool)

opencode v2 has **no `question.*` endpoints**: the agent's `question` tool creates a *form* and blocks the turn until it is replied to or cancelled. Verified against a live **2.0.21** server: `metadata.kind === "question"`, `metadata.tool.id` matches the tool part's `callID`, and a reply resumes the turn.

`Form.Info` (as carried by `form.created`, `GET /api/form` and `GET /api/session/:id/form`):

```ts
{
  id: string            // "frm_…"
  sessionID: string
  title: string         // "Questions"
  metadata?: {
    kind: "question"                        // other kinds exist (e.g. MCP elicitation)
    tool: { messageID: string; id: string } // id === the question tool callID
  }
  fields: Form.Field[]  // non-empty
}
```

`Form.Field` is a union on `type`:

- `string`: `options?: { value, label, description? }[]`, `custom?`, `placeholder?`, `format?` (`email | uri | date | date-time`), `minLength`/`maxLength`/`pattern`, `default?`
- `number` / `integer`: `minimum?` / `maximum?` / `default?`
- `boolean`: `default?`
- `multiselect`: `options` (required), `minItems?` / `maxItems?` / `custom?` / `default?`
- `external`: `url` (informational, not answerable)

Every field also has `key`, `title?`, `description?`, `required?`, `hidden?` and `when?: { key, op: "eq" | "neq", value }[]` (conditional visibility).

The `question` tool maps its input to fields as follows: `key = q<index>`, `title = question.header`, `description = question.question`, `type = multiple ? "multiselect" : "string"`, option `value = label`, and `custom: true`.

API (reachable through the BFF `/api/oc` proxy):

- List pending forms: `GET /api/form?location[directory]=<abs-path>` → `Form.Info[]`; per session: `GET /api/session/:id/form`.
- One form with its state: `GET /api/session/:id/form/:formID` → `Form.Detail` with `state: { status: "pending" } | { status: "answered"; answer } | { status: "cancelled"; message? }`.
- Reply: `POST /api/session/:id/form/:formID/reply` body `{ "answer": { "<key>": <Form.Value> } }` (`string | number | boolean | string[]`).
- Cancel: `DELETE /api/session/:id/form/:formID`.

### `SessionStatus` (`session.status`)

```ts
{ type: "idle" }
| { type: "busy" }
| { type: "retry"; attempt: number; message: string; next: number; action?: { … } }
```

### Subagents (`subagent` tool)

Verified on **2.0.6** with a live run:

- The tool is named **`subagent`** (v1's `task` no longer exists).
- `input = { agent, description, prompt }`.
- `metadata = { sessionID, status, … }` points at the **child session**; the child is returned by `GET /api/session` with `parentID` set.
- The result is wrapped as `<subagent sessionID="…" state="completed">…</subagent>` (MasterHand strips the wrapper for display and offers "Open session" navigation).

## Integration notes

- List pending permissions: `GET /api/permission/request?location[directory]=<abs-path>` returns `Permission.Request[]`. It is per location — reconcile each workspace (base folder and worktrees), because SSE never replays.
- List pending forms: `GET /api/form?location[directory]=<abs-path>` returns `Form.Info[]`. The agent is blocked until the form is replied to or cancelled, so reconcile it exactly like permissions.
- The UI must not rely on SSE alone for consistency: on open or reconnect, load history with `GET /api/session/:id/message` and pending permissions with the endpoint above.
