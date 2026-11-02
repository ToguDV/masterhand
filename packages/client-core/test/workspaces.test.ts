import { describe, expect, it } from "vitest"
import { WORKSPACE_EVENT_TYPES, workspaceEventOf } from "../src/workspaces"

describe("workspaceEventOf", () => {
  it("parses the synthetic workspace frames", () => {
    expect(workspaceEventOf({ type: "workspace.created", data: { workspace: { id: "ws_1" } } })).toEqual({
      type: "workspace.created",
      workspaceID: "ws_1",
    })
    expect(workspaceEventOf({ type: "workspace.deleted", data: { workspaceID: "ws_1" } })).toEqual({
      type: "workspace.deleted",
      workspaceID: "ws_1",
    })
  })

  it("tolerates missing payloads and rejects unrelated frames", () => {
    expect(workspaceEventOf({ type: "workspace.created", data: {} })).toEqual({
      type: "workspace.created",
      workspaceID: null,
    })
    expect(workspaceEventOf({ type: "workspace.deleted" })).toEqual({
      type: "workspace.deleted",
      workspaceID: null,
    })
    for (const event of [
      null,
      "workspace.created",
      { type: "session.created", data: {} },
      { type: "board.updated", data: {} },
    ]) {
      expect(workspaceEventOf(event)).toBeNull()
    }
  })

  it("publishes the frame names", () => {
    expect(WORKSPACE_EVENT_TYPES).toEqual(["workspace.created", "workspace.deleted"])
  })
})
