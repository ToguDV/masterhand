# SPEC — MasterHand

High-level specification of the project. For the technical design see `ARCHITECTURE.md`; for status see `PROGRESS.md`.

## 1. Summary

MasterHand is a self-hosted server that lets a single developer use their [opencode](https://opencode.ai) agents from any device. It ships three frontends over one shared backend:

- **Web** — React 19 + Vite, served by the BFF.
- **Desktop** — Electron shell that packages the web build.
- **Mobile** — React Native (Expo) app with its own UI.

The agent engine is `opencode serve`. MasterHand adds authentication, a secure proxy, a chat UI with live streaming, remote permission approvals, and in-app notifications. It is open source, so anyone can deploy their own instance; it is designed for a **single user across multiple devices**, not for multi-user teams.

## 2. Problem and motivation

- opencode is a powerful TUI, but it is not designed for remote use from a phone or desktop app.
- Existing solutions (e.g. OpenChamber) are excellent but general-purpose; MasterHand aims for a focused, controlled interface.
- What is needed: access from any device, sessions that keep running on the server, remote permission approvals, and in-app awareness of when the agent finishes or asks for something.

## 3. Target user

One user: the owner of the instance (single-user, multi-device). No teams, roles or per-user permissions.

## 4. MVP goals

1. **Chat with agents** from web, desktop and mobile: sessions, prompts, live streaming.
2. **Remote permission approvals**: answer agent requests without SSH.
3. **In-app notifications** over SSE: know when the agent finishes, fails or asks for permission.
4. **Open-source deployability**: any developer can run their own instance with their own TLS setup.

## 5. Functional requirements

| ID | Requirement | Detail |
|---|---|---|
| FR-1 | Authentication | Password login; HttpOnly cookie for web/desktop on the serving origin; per-server Bearer device tokens for remote servers and mobile; multiple saved server profiles with independent credentials and one active connection; persistent session; disconnect/logout; login rate limiting |
| FR-2 | Sessions | List sessions grouped by project; create, open and delete; distinguish states (idle / busy / error) |
| FR-3 | Chat | Send text prompts; choose agent and model; render history (text, tool calls, reasoning); live streaming of the response |
| FR-4 | Approvals | Show permission requests (`permission.updated`) with title, type, pattern and metadata; answer "once" / "always" / "reject"; reflect `permission.replied` |
| FR-5 | Clients | Web app, Electron desktop app and React Native mobile app sharing one `client-core` package |
| FR-6 | Notifications | In-app notifications over SSE for `session.idle`, `permission.updated` and `session.error`; tapping opens the corresponding session (deep link). Android additionally shows local system notifications for agent finishes, failures, permission requests and question forms when the app is backgrounded (opt-in, no Play Console/Firebase); a periodic background check covers the closed-app case best-effort |
| FR-7 | Resilience | SSE reconnection with message refetch and deduplication by `part.id`; the UI never stays inconsistent after losing connection or returning from background |
| FR-8 | Health | Status indicator for the BFF and the opencode connection |
| FR-9 | Self-hosting | Generic configuration (no hardcoded domain); deployer provides the reverse proxy and TLS |
| FR-10 | Previews | Preview any web project the agent runs: a fixed port is reserved per session and exposed through a Cloudflare quick tunnel with explicit Start/Stop, embedded in the web/desktop UI and the mobile app. Public and ephemeral by design; for testing only, never for production data |
| FR-11 | Scheduled tasks | Recurring agent tasks managed from the Scheduler section (the desktop sidebar panel, the web/native mobile tab): schedule presets or a custom cron expression, model, workspace and timezone; each fire starts a new opencode session with the stored prompt and model; tasks appear in the section with run history, pause/resume and run-now; fires surface over SSE (`scheduler.updated`, extending FR-6) |

## 6. Non-functional requirements

| ID | Requirement | Detail |
|---|---|---|
| NFR-1 | Security | HTTPS required in production (provided by the deployer); opencode without published ports (internal network only); HttpOnly + Secure + SameSite=Strict cookie on web; opencode password only on the server; agent runs as an unprivileged user |
| NFR-2 | Privacy | Single-user; sessions, data and API keys reside only on the owner's server |
| NFR-3 | Mobility | Usable on screens ≥360px; native mobile app for iOS and Android |
| NFR-4 | Performance | First render <2s on 4G; perceived streaming <1s; proxy without SSE buffering |
| NFR-5 | Operability | Deployment with Docker Compose and `restart: unless-stopped`; volume backups; pinned opencode version |
| NFR-6 | Simplicity | No complex infrastructure: SQLite for device/token storage; one BFF process |
| NFR-7 | Diagnostics | BFF and opencode logs accessible from the host |
| NFR-8 | Portability | Runs anywhere Docker and Node are available; TLS is out of the repository's scope |

## 7. Out of scope (MVP)

- Remote push notifications (FCM/APNs/Expo Push) — local Android notifications only, no push service or store account.
- PWA / service worker / installable web app.
- Terminal in the browser.
- Advanced visual diffs.
- Multi-run, session goals, walkthroughs, GitHub workflows.
- Multi-user, teams, roles and per-user permissions.
- Agent sandbox/container isolation (evaluated post-MVP).

## 8. Acceptance criteria (end-to-end demo)

1. [ ] From a phone on a mobile network, on the deployer's own domain: login and session list.
2. [ ] Create a session, request a simple task and see streaming + tool calls live.
3. [ ] Receive and answer a permission request from the phone.
4. [ ] Get an in-app notification when the turn finishes; tapping opens the right session.
5. [ ] An external scan confirms only the reverse proxy port (and SSH) are exposed; opencode is unreachable from outside.
6. [ ] Restart the host: `docker compose` brings the services back up and the session continues.

## 9. Success metrics

- Daily use from mobile and desktop without SSH.
- 0 security incidents.
- Time between permission notification and response < 30s.

## 10. Assumptions and dependencies

- A Linux host with Docker + Docker Compose (provider-agnostic), or any environment capable of running the BFF and opencode.
- The deployer owns the domain and provides TLS termination (Caddy, Nginx, Traefik, a tunnel, etc.).
- Model provider API keys (Anthropic, OpenAI, etc.) available to the opencode container.
- opencode installed and working with a pinned version.
- Modern iOS/Android for the native app.
