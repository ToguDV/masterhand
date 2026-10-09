import type { AgentInfo, PromptAgentMention, SlashCommand } from "./types"

/**
 * Pure composer helpers shared by web and mobile: trigger detection for the
 * `/` command and `@` subagent popovers, catalog filtering and mention
 * collection. No DOM and no React — deterministic and unit-testable.
 */

export type ComposerTrigger =
  | { kind: "command"; query: string; start: number; end: number }
  | { kind: "agent"; query: string; start: number; end: number }
  | {
      kind: "arguments"
      command: string
      query: string
      start: number
      end: number
      /** True when an argument token already precedes the caret's (empty) token. */
      hasArgument: boolean
    }

const WHITESPACE = /\s/

/** Start of the whitespace-delimited token that contains `position`. */
function tokenStart(text: string, position: number): number {
  let start = position
  while (start > 0 && !WHITESPACE.test(text[start - 1] ?? "")) start -= 1
  return start
}

/** End (exclusive) of the whitespace-delimited token that contains `position`. */
function tokenEnd(text: string, position: number): number {
  let end = position
  while (end < text.length && !WHITESPACE.test(text[end] ?? "")) end += 1
  return end
}

/**
 * `@` mention under the caret. The `@` must open the token (start of text or
 * preceded by whitespace), so emails and `foo@bar` never trigger it.
 */
function agentTrigger(text: string, caret: number): ComposerTrigger | null {
  const start = tokenStart(text, caret)
  if (text[start] !== "@") return null
  const end = tokenEnd(text, caret)
  return { kind: "agent", query: text.slice(start + 1, end), start, end }
}

/**
 * `/` command or its argument region. Commands only count at the start of the
 * message, mirroring opencode: `/` opens the name popover, and once the name is
 * followed by whitespace the caret is in the argument region.
 */
function commandTrigger(text: string, caret: number): ComposerTrigger | null {
  if (text[0] !== "/") return null

  let nameEnd = text.length
  for (let index = 1; index < text.length; index += 1) {
    if (WHITESPACE.test(text[index] ?? "")) {
      nameEnd = index
      break
    }
  }

  if (caret <= nameEnd) {
    return { kind: "command", query: text.slice(1, nameEnd), start: 0, end: nameEnd }
  }

  const command = text.slice(1, nameEnd)
  if (!command) return null
  const start = tokenStart(text, caret)
  const end = tokenEnd(text, caret)
  // Anything non-blank between the command name and this token means the user
  // already wrote an argument, so an empty token after it is just a separator.
  const hasArgument = text.slice(nameEnd, start).trim() !== ""
  return { kind: "arguments", command, query: text.slice(start, end), start, end, hasArgument }
}

/**
 * Active popover for `text` with the caret at `caret`. An `@` mention wins over
 * the command argument region, so subagents can be mentioned inside arguments.
 * Returns `null` when no popover should be open.
 */
export function composerTrigger(text: string, caret: number): ComposerTrigger | null {
  const position = Math.max(0, Math.min(caret, text.length))
  return agentTrigger(text, position) ?? commandTrigger(text, position)
}

/** Commands matching `query`, prefix matches first (name, then description). */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const term = query.trim().toLowerCase()
  if (!term) return commands
  const prefix: SlashCommand[] = []
  const rest: SlashCommand[] = []
  for (const command of commands) {
    const name = command.name.toLowerCase()
    if (name.startsWith(term)) prefix.push(command)
    else if (name.includes(term) || (command.description ?? "").toLowerCase().includes(term)) rest.push(command)
  }
  return [...prefix, ...rest]
}

/** Agents that can be mentioned with `@` (subagents and dual-mode agents). */
export function mentionableAgents(agents: AgentInfo[]): AgentInfo[] {
  return agents.filter((agent) => agent.hidden !== true && (agent.mode === "subagent" || agent.mode === "all"))
}

/**
 * Commands MasterHand implements itself (not opencode server commands), merged
 * into the `/` popover. A server command with the same name never shadows them.
 */
export const appCommands: SlashCommand[] = [
  {
    name: "btw",
    description: "Ask a side question (temporary session, does not affect this chat)",
    arguments: [{ position: 0, freeForm: true, suggestions: [] }],
  },
  {
    name: "goal",
    description: "Work on a goal until an adversarial review approves it",
    arguments: [{ position: 0, freeForm: true, suggestions: [] }],
  },
]

/** App commands first, then the server catalog without name collisions. */
export function mergeCommands(commands: SlashCommand[]): SlashCommand[] {
  const reserved = new Set(appCommands.map((command) => command.name))
  return [...appCommands, ...commands.filter((command) => !reserved.has(command.name))]
}

/** Mentionable agents matching `query` by id or display name. */
export function filterAgentMentions(agents: AgentInfo[], query: string): AgentInfo[] {
  const term = query.trim().toLowerCase()
  if (!term) return agents
  return agents.filter(
    (agent) => agent.id.toLowerCase().includes(term) || agent.name.toLowerCase().includes(term),
  )
}

/** Candidate values for the command, filtered by the partial argument typed. */
export function argumentSuggestions(command: SlashCommand, query: string): string[] {
  const unique = [...new Set(command.arguments.flatMap((argument) => argument.suggestions))]
  const term = query.trim().toLowerCase()
  if (!term) return unique
  return unique.filter((value) => value.toLowerCase().startsWith(term))
}

/** Human hint for the arguments a command declares, or `null` when it takes none. */
export function commandArgumentHint(command: SlashCommand): string | null {
  if (command.arguments.length === 0) return null
  if (command.arguments.some((argument) => argument.freeForm)) return "free-form arguments"
  return command.arguments.length === 1 ? "1 argument" : `${command.arguments.length} arguments`
}

export interface ComposerPopoverItem {
  id: string
  label: string
  detail?: string
  /** Text that replaces the active trigger when the item is selected. */
  replacement: string
}

export interface ComposerPopover {
  title: string
  hint: string | null
  items: ComposerPopoverItem[]
  emptyLabel: string
}

/**
 * Resolves the popover for an active trigger from the command and subagent
 * catalogs. Shared by web and mobile so both render the same options; returns
 * `null` when nothing should be shown (unknown command, no matches, no args).
 */
export function buildComposerPopover(
  trigger: ComposerTrigger,
  commands: SlashCommand[],
  agents: AgentInfo[],
): ComposerPopover | null {
  if (trigger.kind === "command") {
    const items = filterCommands(commands, trigger.query).map((command) => ({
      id: `command:${command.name}`,
      label: `/${command.name}`,
      detail: command.description,
      replacement: `/${command.name} `,
    }))
    return items.length > 0 ? { title: "Commands", hint: null, items, emptyLabel: "No matches" } : null
  }

  if (trigger.kind === "agent") {
    const items = filterAgentMentions(agents, trigger.query).map((agent) => ({
      id: `agent:${agent.id}`,
      label: `@${agent.id}`,
      detail: agent.name !== agent.id ? agent.name : agent.description,
      replacement: `@${agent.id} `,
    }))
    return items.length > 0 ? { title: "Subagents", hint: null, items, emptyLabel: "No matches" } : null
  }

  const command = commands.find((item) => item.name === trigger.command)
  if (!command || command.arguments.length === 0) return null

  const term = trigger.query.trim()
  const values = argumentSuggestions(command, term)
  // A typed token only shows content matches; a non-matching one shows nothing.
  if (term && values.length === 0) return null
  // An empty token right after an argument was already written is a separator,
  // not an empty parameter: keep the list closed so a picked value cannot
  // re-suggest itself (or its siblings) forever.
  if (!term && trigger.hasArgument) return null

  if (values.length === 0) {
    // Empty token for a command that declares arguments without candidate
    // values (free-form or positional placeholders).
    return {
      title: `/${command.name}`,
      hint: commandArgumentHint(command),
      items: [],
      emptyLabel: "Type the arguments…",
    }
  }

  return {
    title: `/${command.name}`,
    hint: commandArgumentHint(command),
    items: values.map((value) => ({
      id: `argument:${value}`,
      label: value,
      replacement: `${value} `,
    })),
    emptyLabel: "No matches",
  }
}

/**
 * Subagent mentions present in `text`, matched against the mentionable agents.
 * Ranges are computed at send time so edits or extra whitespace never produce a
 * stale offset. The attachment always uses the agent id opencode resolves.
 */
export function collectAgentMentions(text: string, agents: AgentInfo[]): PromptAgentMention[] {
  if (agents.length === 0) return []
  const byToken = new Map<string, AgentInfo>()
  for (const agent of agents) {
    byToken.set(agent.id.toLowerCase(), agent)
    byToken.set(agent.name.toLowerCase(), agent)
  }

  const mentions: PromptAgentMention[] = []
  for (const match of text.matchAll(/(^|[\s([{"'])@([A-Za-z0-9._-]+)/g)) {
    // Trailing sentence punctuation is not part of the agent id (`@general.`).
    const token = (match[2] ?? "").replace(/[.,!?;:)\]}]+$/, "")
    if (!token) continue
    const agent = byToken.get(token.toLowerCase())
    if (!agent) continue
    const start = (match.index ?? 0) + (match[1] ?? "").length
    const mentionText = `@${token}`
    mentions.push({ name: agent.id, mention: { start, end: start + mentionText.length, text: mentionText } })
  }
  return mentions
}

/**
 * Splits a message that starts with `/name` into the command and its argument
 * text. Returns `null` when it is not a known command, so it can be sent as a
 * normal prompt.
 */
export function splitCommand(
  text: string,
  commands: SlashCommand[],
): { command: SlashCommand; text: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  const command = commands.find((item) => item.name === match[1])
  if (!command) return null
  return { command, text: (match[2] ?? "").trim() }
}
