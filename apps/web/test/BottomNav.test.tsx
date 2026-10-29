// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BottomNav } from "../src/components/BottomNav"

afterEach(cleanup)

describe("BottomNav", () => {
  it("renders the home sections plus the settings action", () => {
    render(<BottomNav section="sessions" onSelectSection={() => {}} onOpenSettings={() => {}} />)

    const nav = screen.getByRole("navigation", { name: "Main navigation" })
    expect(nav).toBeTruthy()
    for (const label of ["Sessions", "Board", "Scheduler", "Settings"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy()
    }
  })

  it("marks only the active section and never Settings", () => {
    render(<BottomNav section="board" onSelectSection={() => {}} onOpenSettings={() => {}} />)

    expect(screen.getByRole("button", { name: "Board" }).getAttribute("aria-current")).toBe("page")
    expect(screen.getByRole("button", { name: "Sessions" }).getAttribute("aria-current")).toBeNull()
    expect(screen.getByRole("button", { name: "Scheduler" }).getAttribute("aria-current")).toBeNull()
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBeNull()
  })

  it("reports section selections and the settings action", () => {
    const onSelectSection = vi.fn()
    const onOpenSettings = vi.fn()
    render(
      <BottomNav section="sessions" onSelectSection={onSelectSection} onOpenSettings={onOpenSettings} />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Scheduler" }))
    expect(onSelectSection).toHaveBeenCalledWith("scheduler")

    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })
})
