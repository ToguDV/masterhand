// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WorkspaceRecord } from "@masterhand/client-core"
import { WorkspacePicker } from "../src/components/WorkspacePicker"

afterEach(cleanup)

function workspaces(count: number): WorkspaceRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `ws${index}`,
    name: `project-${index}`,
    path: `/workspaces/project-${index}`,
    createdAt: index,
  }))
}

function setup(overrides: Partial<React.ComponentProps<typeof WorkspacePicker>> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  }
  render(<WorkspacePicker workspaces={workspaces(7)} selectedID={null} {...handlers} />)
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }))
  return handlers
}

describe("WorkspacePicker", () => {
  it("previews the five most recent workspaces and expands with Show all", () => {
    setup()

    expect(screen.getByRole("menuitemradio", { name: "project-6" })).toBeTruthy()
    expect(screen.getByRole("menuitemradio", { name: "project-2" })).toBeTruthy()
    expect(screen.queryByRole("menuitemradio", { name: "project-1" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Show all 7" }))
    expect(screen.getByRole("menuitemradio", { name: "project-1" })).toBeTruthy()
    expect(screen.getByRole("menuitemradio", { name: "project-0" })).toBeTruthy()
  })

  it("searches workspaces by name and path", () => {
    setup()

    fireEvent.change(screen.getByRole("textbox", { name: "Search workspace" }), {
      target: { value: "project-1" },
    })
    expect(screen.getByRole("menuitemradio", { name: "project-1" })).toBeTruthy()
    expect(screen.queryByRole("menuitemradio", { name: "project-6" })).toBeNull()
  })

  it("keeps the selected workspace in the preview even when it is old", () => {
    setup({ selectedID: "ws0" })

    expect(screen.getByRole("menuitemradio", { name: "project-0" })).toBeTruthy()
    expect(screen.getByRole("menuitemradio", { name: "project-6" })).toBeTruthy()
    expect(screen.queryByRole("menuitemradio", { name: "project-2" })).toBeNull()
  })

  it("selects a workspace and keeps the management actions", () => {
    const handlers = setup({ selectedID: "ws1" })

    fireEvent.click(screen.getByRole("menuitemradio", { name: "project-6" }))
    expect(handlers.onSelect).toHaveBeenCalledWith("ws6")

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Add workspace" }))
    expect(handlers.onAdd).toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove workspace" }))
    expect(handlers.onDelete).toHaveBeenCalledWith("ws1")
  })
})
