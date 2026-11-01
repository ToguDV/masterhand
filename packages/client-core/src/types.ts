import type {
  AgentInfo,
  JsonValue,
  ModelInfo,
  ModelRef,
  PermissionRequest,
  ProviderInfo,
  SessionInfo,
  SessionStructuredError,
  SessionStatus,
  TokenUsageInfo,
} from "@opencode/client"

export type {
  AgentInfo,
  FormAnswer,
  FormDetail,
  FormField,
  FormInfo,
  FormOption,
  FormState,
  FormValue,
  ModelInfo,
  ModelRef,
  ModelVariant,
  PermissionRequest,
  ProviderInfo,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionMessageUser,
  SessionStatus,
  SessionStructuredError,
  TokenUsageInfo,
  V2Event,
} from "@opencode/client"

/**
 * A pending opencode permission request (v2 `Permission.Request`). Also carried
 * by the `permission.asked` event and `GET /api/permission/request`.
 */
export type Permission = PermissionRequest

export type PermissionResponse = "once" | "always" | "reject"

/** The model a session last ran with (opencode persists it per session). */
export type SessionModel = ModelRef

export interface Session extends SessionInfo {
  /**
   * Internal Goal Mode role (added by the BFF). Critic/judge sessions are
   * reachable from the main session's review cards, never from the sidebar:
   * the pinned opencode (v2.0.6) drops `parentID` on session create, so
   * MasterHand marks them itself and `rootSessions` filters them.
   */
  goalRole?: "critic" | "judge"
}

export interface CreateSessionInput {
  /**
   * Per-request marker persisted as session metadata
   * (`masterhand.create`), so a lost create response can be reconciled.
   */
  marker?: string
}

/** Local git branches of a workspace folder. */
export interface GitBranches {
  current: string
  branches: string[]
}

export interface DeviceRecord {
  id: string
  /** Editable display label; identity comes from `installID`. */
  name: string
  /** Stable install id sent by the client, or null for older clients. */
  installID: string | null
  createdAt: number
  lastUsedAt: number
}

export interface WorkspaceRecord {
  id: string
  name: string
  path: string
  createdAt: number
}

export interface CreateWorkspaceInput {
  name: string
}

export interface BffStatus {
  ok: boolean
  /** Release version baked into the server image (#131); absent on older BFFs. */
  version?: string
  /** Build id baked into the server image (#131); absent on older BFFs. */
  build?: string
  opencode?: {
    healthy: boolean
    version?: string
    /** Why opencode is not healthy, when it is not. */
    error?: "unauthorized" | "unreachable"
  }
  preview?: PreviewAvailability
  /** Data-volume headroom, when the BFF could read it. */
  storage?: {
    /** False when the database does not answer a trivial read. */
    ok: boolean
    freeBytes: number | null
    /** Free space below the configured watermark: clients warn the user. */
    low: boolean
  }
  /**
   * One-click updater capability (#134); absent on older BFFs. The sidecar is
   * opt-in: `enabled` requires a configured URL/token, and `tracksLatest`
   * requires the floating `latest` image tag (a pinned deployment keeps the
   * manual `docker compose pull && up -d` flow).
   */
  updater?: {
    enabled: boolean
    tracksLatest: boolean
    /** Image tag the deployment tracks, when the BFF reports it. */
    track?: string
  }
}

export interface PreviewPortRange {
  min: number
  max: number
}

export interface PreviewAvailability {
  enabled: boolean
  available: boolean
  portRange: PreviewPortRange
}

export type PreviewPhase = "stopped" | "starting" | "running" | "error"

/** State of a session's Cloudflare quick-tunnel preview, owned by the BFF. */
export interface PreviewStatus {
  status: PreviewPhase
  /** Public trycloudflare.com URL while the tunnel is running. */
  url: string | null
  /**
   * Last URL the tunnel announced, retained after stop or failure for
   * diagnosis. Absent on older BFFs.
   */
  lastUrl?: string | null
  /** Port reserved for the session's dev server (null until first used). */
  port: number | null
  error: string | null
}

/**
 * A blocked action kept for diagnosis. `permission_denied` is an opencode tool
 * call rejected by the session permission guard (the broad-kill commands).
 */
export interface AuditEvent {
  id: number
  at: number
  sessionID: string | null
  workspaceID: string | null
  kind: "permission_denied" | "run_rejected"
  command: string | null
  reason: string | null
  source: "opencode" | "bff"
}

/** How MasterHand starts a workspace's dev server (argv, no shell). */
export interface WorkspaceRunConfig {
  command: string
  args: string[]
  /** Optional working directory, relative to the workspace. */
  cwd: string | null
  /** Who proposed it: the agent (`.masterhand/run.json`) or the user. */
  source: "agent" | "user"
  updatedAt?: number
}

/** Agent-proposed run command detected from `.masterhand/run.json`. */
export interface RunCandidate {
  command: string
  args: string[]
  cwd: string | null
}

export type RunPhase = "stopped" | "starting" | "running" | "error"

/** State of a session's managed dev server (owned by the BFF). */
export interface RunStatus {
  status: RunPhase
  command: string | null
  args: string[]
  /** Reserved preview port (the `{port}` value and `PORT` env). */
  port: number | null
  pid: number | null
  error: string | null
}

export interface DeviceLoginResponse {
  token: string
  device: DeviceRecord
}

export type SessionStatuses = Record<string, SessionStatus>

/** Catalog used by the model selector: models, providers and the server default. */
export interface ModelsCatalog {
  models: ModelInfo[]
  providers: ProviderInfo[]
  defaultModel: ModelInfo | null
}

export interface PromptInput {
  text: string
  /** Agent id to run the turn with (switched before prompting when it changed). */
  agent?: string
  /** Model (and optional variant) to run the turn with. */
  model?: ModelRef
  /** Subagents mentioned with `@` in `text`. */
  agents?: PromptAgentMention[]
  /**
   * Files opencode materializes into the model context. Only data: and file:
   * URIs are accepted; MasterHand's proxy confines file: to its attachment
   * store (`.masterhand/attachments`).
   */
  files?: PromptFileAttachmentInput[]
  /**
   * Metadata opencode persists on the created user message. MasterHand uses it
   * for the per-send delivery marker (see `delivery.ts`) and the attachment
   * index (`masterhand.attachments`).
   */
  metadata?: Record<string, JsonValue>
}

/** Input to run a slash command (the argument text plus optional context). */
export interface RunCommandInput {
  /** Command name without the leading slash. */
  name: string
  /** Argument text sent to the command. */
  text: string
  agent?: string
  model?: ModelRef
  agents?: PromptAgentMention[]
  /** Same prompt-file attachments as `PromptInput.files`. */
  files?: PromptFileAttachmentInput[]
}

/** One prompt `files` entry accepted by opencode. */
export interface PromptFileAttachmentInput {
  /** data: URL or file: URL (MasterHand attachments only). */
  uri: string
  name?: string
  description?: string
}

/**
 * A file uploaded to the BFF's attachment store. `path`/`uri` are only used
 * while building the prompt; the message metadata keeps `url` for the UI.
 */
export interface UploadedAttachment {
  /** Client-generated id; retrying an upload with the same id is idempotent. */
  id: string
  name: string
  /** MIME sniffed by the BFF, not the browser's guess. */
  mime: string
  size: number
  /** Absolute path on the server (the agent's tools read it from here). */
  path: string
  /** `file:` URL for opencode's prompt files. */
  uri: string
  /** Authenticated BFF URL for previews/downloads. */
  url: string
}

/** A file the composer is about to send (local until Send uploads it). */
export interface AttachmentUpload {
  /** Client-generated id, reused by retries. */
  id: string
  name: string
  /** Browser/RN MIME hint; the BFF sniffs the real one. */
  mime: string
  size: number
  /** Web: the File/Blob body. */
  body?: Blob
  /** React Native: the local file URI returned by the document picker. */
  uri?: string
}

/** Attachment summary persisted in a user message's metadata. */
export interface ChatAttachment {
  id: string
  name: string
  mime: string
  size: number
  /** BFF download/preview URL; empty only for legacy messages without metadata. */
  url: string
  /** Whether opencode received the bytes as a prompt file part. */
  inline: boolean
  /** Inline image preview (from the message's `files[].data`). */
  previewDataUrl?: string
}

/** A subagent mention attached to a prompt, with the range it occupies in the text. */
export interface PromptAgentMention {
  /** Agent id opencode resolves the mention against. */
  name: string
  mention: { start: number; end: number; text: string }
}

/** Deterministic argument hint for a slash command (see the BFF `/api/commands`). */
export interface CommandArgument {
  /** 1-based positional slot; 0 when the command accepts free-form trailing text. */
  position: number
  freeForm: boolean
  /** Candidate values parsed from the command's own description. Never generated. */
  suggestions: string[]
}

export interface SlashCommand {
  name: string
  description?: string
  arguments: CommandArgument[]
}

/** Current agent/model of the session, used to avoid redundant switch calls. */
export interface PromptContext {
  agent?: string
  model?: ModelRef
}

/** Normalized chat view model shared by web and mobile. */
export interface ChatMessageInfo {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time: { created: number; streamed?: number; completed?: number }
  agent?: string
  providerID?: string
  modelID?: string
  cost?: number
  tokens?: TokenUsageInfo
  error?: SessionStructuredError
  /** Metadata opencode persisted on the message (user messages carry the send marker). */
  metadata?: Record<string, unknown>
  /** Files the user attached (user messages only). */
  attachments?: ChatAttachment[]
}

export type ChatToolStatus = "pending" | "running" | "completed" | "error"

/** Wall-clock marks opencode tracks for a tool call (all in epoch ms). */
export interface ChatToolTiming {
  created?: number
  ran?: number
  completed?: number
}

export interface ChatToolState {
  status: ChatToolStatus
  title?: string
  input: Record<string, unknown>
  output?: string
  error?: string
  metadata?: Record<string, unknown>
  /** Raw (partial) JSON while the tool input is still streaming. */
  raw?: string
  /** Timing marks (history projection, plus live marks from tool events). */
  timing?: ChatToolTiming
}

export type ChatTextPart = {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
}

export type ChatReasoningPart = {
  id: string
  sessionID: string
  messageID: string
  type: "reasoning"
  text: string
}

export type ChatToolPart = {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  tool: string
  callID: string
  state: ChatToolState
}

export type ChatPart = ChatTextPart | ChatReasoningPart | ChatToolPart

export interface ChatMessage {
  info: ChatMessageInfo
  parts: ChatPart[]
}
