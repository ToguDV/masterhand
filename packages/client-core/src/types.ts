import type {
  AgentInfo,
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

/**
 * MasterHand metadata for a session running in its own git worktree
 * (isolated mode). Added by the BFF; opencode itself knows nothing about it.
 */
export interface SessionIsolation {
  isolated: true
  /** Worktree directory the session runs in (its opencode location). */
  worktreePath: string
  /** Branch checked out in the worktree (unique per worktree). */
  branch: string
  /** Branch/commit the worktree was created from. */
  baseRef: string
  pushed?: boolean
  prUrl?: string | null
}

export interface Session extends SessionInfo {
  isolation?: SessionIsolation
}

export interface CreateSessionInput {
  /** Run the session in its own git worktree instead of the workspace folder. */
  isolated?: boolean
}

export interface FinishSessionResult {
  committed: boolean
  pushed: boolean
  prUrl: string | null
  branch: string
  path: string
  /** Push failure detail, when the branch could not be pushed. */
  error: string | null
}

export interface DeviceRecord {
  id: string
  name: string
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
  opencode?: {
    healthy: boolean
    version?: string
    /** Why opencode is not healthy, when it is not. */
    error?: "unauthorized" | "unreachable"
  }
  preview?: PreviewAvailability
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
