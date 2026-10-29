import { fireEvent, render, screen } from "@testing-library/react-native"
import { BottomNav, type HomeSection } from "../src/components/BottomNav"
import { ThemeProvider } from "../src/theme"

async function setup(
  props: Partial<{
    section: HomeSection
    onSelectSection: (section: HomeSection) => void
    onOpenSettings: () => void
    showBoard: boolean
    showScheduler: boolean
  }> = {},
) {
  const handlers = {
    onSelectSection: jest.fn(),
    onOpenSettings: jest.fn(),
    ...props,
  }
  await render(
    <ThemeProvider>
      <BottomNav section={props.section ?? "sessions"} {...handlers} showBoard={props.showBoard} showScheduler={props.showScheduler} />
    </ThemeProvider>,
  )
  return handlers
}

describe("BottomNav", () => {
  it("renders the home sections plus the settings action", async () => {
    await setup()

    expect(screen.getByLabelText("Main navigation")).toBeOnTheScreen()
    expect(screen.getByLabelText("Show sessions")).toBeOnTheScreen()
    expect(screen.getByLabelText("Show board")).toBeOnTheScreen()
    expect(screen.getByLabelText("Show scheduler")).toBeOnTheScreen()
    expect(screen.getByText("Sessions")).toBeOnTheScreen()
    expect(screen.getByText("Board")).toBeOnTheScreen()
    expect(screen.getByText("Scheduler")).toBeOnTheScreen()
    expect(screen.getByText("Settings")).toBeOnTheScreen()
  })

  it("marks only the active section as selected", async () => {
    await setup({ section: "board" })

    expect(screen.getByLabelText("Show board").props.accessibilityState?.selected).toBe(true)
    expect(screen.getByLabelText("Show sessions").props.accessibilityState?.selected).toBe(false)
    expect(screen.getByLabelText("Show scheduler").props.accessibilityState?.selected).toBe(false)
    // Settings is an action, not a section: it never renders a tab.
    expect(screen.getByLabelText("Settings").props.accessibilityRole).toBe("button")
  })

  it("requests a section when its tab is pressed", async () => {
    const handlers = await setup()

    await fireEvent.press(screen.getByLabelText("Show scheduler"))
    expect(handlers.onSelectSection).toHaveBeenCalledWith("scheduler")

    await fireEvent.press(screen.getByLabelText("Show sessions"))
    expect(handlers.onSelectSection).toHaveBeenCalledWith("sessions")
  })

  it("opens settings without changing the section", async () => {
    const handlers = await setup()

    await fireEvent.press(screen.getByLabelText("Settings"))

    expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1)
    expect(handlers.onSelectSection).not.toHaveBeenCalled()
  })

  it("hides the board and scheduler tabs when their slots are absent", async () => {
    await setup({ showBoard: false, showScheduler: false })

    expect(screen.getByLabelText("Show sessions")).toBeOnTheScreen()
    expect(screen.queryByLabelText("Show board")).toBeNull()
    expect(screen.queryByLabelText("Show scheduler")).toBeNull()
    expect(screen.getByLabelText("Settings")).toBeOnTheScreen()
  })
})
