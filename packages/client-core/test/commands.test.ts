import { describe, expect, it } from "vitest"
import {
  appCommands,
  argumentSuggestions,
  buildComposerPopover,
  collectAgentMentions,
  commandArgumentHint,
  composerTrigger,
  filterAgentMentions,
  filterCommands,
  mentionableAgents,
  mergeCommands,
  splitCommand,
} from "../src/commands"
import type { AgentInfo, SlashCommand } from "../src/types"

const commands: SlashCommand[] = [
  { name: "review", description: "review changes [commit|branch|pr]", arguments: [{ position: 1, freeForm: false, suggestions: ["commit", "branch", "pr"] }] },
  { name: "init", description: "guided AGENTS.md setup", arguments: [] },
  { name: "component", description: "Create a component", arguments: [{ position: 0, freeForm: true, suggestions: [] }] },
]

function agent(overrides: Partial<AgentInfo>): AgentInfo {
  return { id: "general", name: "General", mode: "subagent", hidden: false, ...overrides } as AgentInfo
}

describe("composerTrigger", () => {
  it("opens the command list while typing a slash command", () => {
    expect(composerTrigger("/rev", 4)).toEqual({ kind: "command", query: "rev", start: 0, end: 4 })
    expect(composerTrigger("/", 1)).toEqual({ kind: "command", query: "", start: 0, end: 1 })
  })

  it("stays on the command name when the caret is inside it", () => {
    expect(composerTrigger("/review", 2)).toEqual({ kind: "command", query: "review", start: 0, end: 7 })
  })

  it("switches to arguments after the command name and a space", () => {
    expect(composerTrigger("/review com", 11)).toEqual({
      kind: "arguments",
      command: "review",
      query: "com",
      start: 8,
      end: 11,
      hasArgument: false,
    })
  })

  it("flags when an argument already precedes the caret's token", () => {
    expect(composerTrigger("/review commit ", 16)).toMatchObject({
      kind: "arguments",
      command: "review",
      query: "",
      hasArgument: true,
    })
  })

  it("opens the agent list on an @ mention", () => {
    expect(composerTrigger("hello @gen", 10)).toEqual({ kind: "agent", query: "gen", start: 6, end: 10 })
  })

  it("lets a subagent mention win inside command arguments", () => {
    expect(composerTrigger("/review @gen", 12)).toEqual({ kind: "agent", query: "gen", start: 8, end: 12 })
  })

  it("ignores mid-word @ and slash", () => {
    expect(composerTrigger("mail@host", 9)).toBeNull()
    expect(composerTrigger("a /review", 9)).toBeNull()
  })

  it("closes once whitespace follows the mention", () => {
    expect(composerTrigger("@gen ", 5)).toBeNull()
  })

  it("clamps a caret beyond the text", () => {
    expect(composerTrigger("/rev", 99)).toMatchObject({ kind: "command", query: "rev" })
  })
})

describe("filterCommands", () => {
  it("returns everything for an empty query", () => {
    expect(filterCommands(commands, "")).toHaveLength(3)
  })

  it("ranks prefix matches before description matches", () => {
    expect(filterCommands(commands, "re").map((command) => command.name)).toEqual(["review", "component"])
    expect(filterCommands(commands, "setup").map((command) => command.name)).toEqual(["init"])
  })
})

describe("mentionableAgents", () => {
  it("keeps subagents and dual-mode agents, dropping hidden and primary agents", () => {
    const list = [
      agent({ id: "build", mode: "primary" }),
      agent({ id: "general", mode: "subagent" }),
      agent({ id: "helper", mode: "all" }),
      agent({ id: "title", mode: "subagent", hidden: true }),
    ]
    expect(mentionableAgents(list).map((item) => item.id)).toEqual(["general", "helper"])
  })

  it("filters by id or display name", () => {
    const list = [agent({ id: "general", name: "General" }), agent({ id: "tester", name: "Tester" })]
    expect(filterAgentMentions(list, "gen").map((item) => item.id)).toEqual(["general"])
    expect(filterAgentMentions(list, "TEST").map((item) => item.id)).toEqual(["tester"])
  })
})

describe("command argument hints", () => {
  it("filters suggestions by the partial argument", () => {
    expect(argumentSuggestions(commands[0]!, "")).toEqual(["commit", "branch", "pr"])
    expect(argumentSuggestions(commands[0]!, "b")).toEqual(["branch"])
    expect(argumentSuggestions(commands[0]!, "c")).toEqual(["commit"])
  })

  it("describes free-form and positional arguments", () => {
    expect(commandArgumentHint(commands[2]!)).toBe("free-form arguments")
    expect(commandArgumentHint(commands[0]!)).toBe("1 argument")
    expect(commandArgumentHint(commands[1]!)).toBeNull()
  })
})

describe("collectAgentMentions", () => {
  const agents = [agent({ id: "general", name: "General" }), agent({ id: "tester", name: "Tester" })]

  it("collects mentions with their exact ranges", () => {
    expect(collectAgentMentions("@general and @tester", agents)).toEqual([
      { name: "general", mention: { start: 0, end: 8, text: "@general" } },
      { name: "tester", mention: { start: 13, end: 20, text: "@tester" } },
    ])
  })

  it("ignores unknown or non-mention tokens", () => {
    expect(collectAgentMentions("@nope mail@general", agents)).toEqual([])
  })

  it("strips trailing punctuation and matches case-insensitively", () => {
    expect(collectAgentMentions("hi @General.", agents)).toEqual([
      { name: "general", mention: { start: 3, end: 11, text: "@General" } },
    ])
  })

  it("short-circuits without agents", () => {
    expect(collectAgentMentions("@general", [])).toEqual([])
  })
})

describe("buildComposerPopover", () => {
  it("lists commands and subagents for the command and agent triggers", () => {
    const commandPopover = buildComposerPopover({ kind: "command", query: "rev", start: 0, end: 4 }, commands, [])
    expect(commandPopover?.title).toBe("Commands")
    expect(commandPopover?.items.map((item) => item.label)).toEqual(["/review"])
    expect(commandPopover?.items[0]?.replacement).toBe("/review ")

    const agentPopover = buildComposerPopover(
      { kind: "agent", query: "gen", start: 0, end: 4 },
      [],
      [agent({ id: "general", name: "General" })],
    )
    expect(agentPopover?.title).toBe("Subagents")
    expect(agentPopover?.items[0]).toMatchObject({ label: "@general", detail: "General", replacement: "@general " })
  })

  it("returns null when a trigger has no matches or no arguments", () => {
    expect(buildComposerPopover({ kind: "command", query: "zzz", start: 0, end: 4 }, commands, [])).toBeNull()
    expect(
      buildComposerPopover({ kind: "arguments", command: "init", query: "", start: 6, end: 6, hasArgument: false }, commands, []),
    ).toBeNull()
    expect(
      buildComposerPopover({ kind: "arguments", command: "missing", query: "", start: 0, end: 0, hasArgument: false }, commands, []),
    ).toBeNull()
  })

  it("lists every value when the parameter is empty", () => {
    const empty = buildComposerPopover(
      { kind: "arguments", command: "review", query: "", start: 8, end: 8, hasArgument: false },
      commands,
      [],
    )
    expect(empty?.items.map((item) => item.label)).toEqual(["commit", "branch", "pr"])
  })

  it("only shows argument values that match the typed content", () => {
    expect(
      buildComposerPopover({ kind: "arguments", command: "review", query: "zzz", start: 8, end: 11, hasArgument: false }, commands, []),
    ).toBeNull()

    const matches = buildComposerPopover(
      { kind: "arguments", command: "review", query: "c", start: 8, end: 9, hasArgument: false },
      commands,
      [],
    )
    expect(matches?.items.map((item) => item.label)).toEqual(["commit"])
  })

  it("keeps the list closed when an argument already precedes an empty token", () => {
    expect(
      buildComposerPopover({ kind: "arguments", command: "review", query: "", start: 16, end: 16, hasArgument: true }, commands, []),
    ).toBeNull()
  })

  it("builds the argument popover with suggestions and an empty hint", () => {
    const withValues = buildComposerPopover(
      { kind: "arguments", command: "review", query: "b", start: 8, end: 9, hasArgument: false },
      commands,
      [],
    )
    expect(withValues?.title).toBe("/review")
    expect(withValues?.hint).toBe("1 argument")
    expect(withValues?.items.map((item) => item.label)).toEqual(["branch"])

    const freeForm = buildComposerPopover(
      { kind: "arguments", command: "component", query: "", start: 11, end: 11, hasArgument: false },
      commands,
      [],
    )
    expect(freeForm?.hint).toBe("free-form arguments")
    expect(freeForm?.items).toEqual([])
    expect(freeForm?.emptyLabel).toBe("Type the arguments…")
  })
})

describe("splitCommand", () => {
  it("splits a known command from its arguments", () => {
    expect(splitCommand("/review commit", commands)).toEqual({
      command: commands[0],
      text: "commit",
    })
    expect(splitCommand("/init", commands)).toEqual({ command: commands[1], text: "" })
  })

  it("returns null for unknown commands or plain text", () => {
    expect(splitCommand("/nope x", commands)).toBeNull()
    expect(splitCommand("hello /review", commands)).toBeNull()
  })
})

describe("app commands", () => {
  it("prepends MasterHand's own commands and reserves their names", () => {
    const server = [{ name: "btw", description: "server btw", arguments: [] }, ...commands]
    const merged = mergeCommands(server)
    expect(merged[0]).toBe(appCommands[0])
    expect(merged.find((command) => command.name === "btw")).toBe(appCommands[0])
    expect(merged.map((command) => command.name)).toEqual(["btw", "goal", "review", "init", "component"])
  })

  it("routes /btw through splitCommand", () => {
    expect(splitCommand("/btw what changed?", mergeCommands(commands))?.command.name).toBe("btw")
  })

  it("routes /goal with its free-form goal text", () => {
    const parsed = splitCommand("/goal make the suite green", mergeCommands(commands))
    expect(parsed?.command.name).toBe("goal")
    expect(parsed?.text).toBe("make the suite green")
  })
})
