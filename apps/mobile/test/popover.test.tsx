import { useEffect, useState } from "react"
import { Dimensions, Keyboard, Pressable, StyleSheet, Text, View } from "react-native"
import { act, fireEvent, render, screen } from "@testing-library/react-native"
import { Popover, popoverLayout, usePopover, type PopoverAnchor } from "../src/components/Popover"

const anchor: PopoverAnchor = { x: 12, y: 100, width: 80, height: 32 }

function Harness({ placement = "down" as const, anchorValue = anchor }: {
  placement?: "up" | "down"
  anchorValue?: PopoverAnchor | null
}) {
  const [open, setOpen] = useState(true)
  return (
    <Popover open={open} anchor={anchorValue} placement={placement} onClose={() => setOpen(false)}>
      <Text>menu item</Text>
    </Popover>
  )
}

describe("Popover", () => {
  it("renders its children and closes from the scrim", async () => {
    await render(<Harness />)

    expect(screen.getByText("menu item")).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Close menu"))

    expect(screen.queryByText("menu item")).toBeNull()
  })

  it("opens above the trigger when placement is up", async () => {
    await render(<Harness placement="up" />)

    expect(screen.getByText("menu item")).toBeOnTheScreen()
  })

  it("keeps the fallback placement when the trigger was never measured", async () => {
    await render(<Harness anchorValue={null} />)

    expect(screen.getByText("menu item")).toBeOnTheScreen()
  })

  it("pins the overlay box to the frozen viewport", async () => {
    // RN 0.88 lays out a Modal's content with the screen minus the system bar
    // insets on the first frame (facebook/react-native#59353) and only then
    // expands it to the full edge-to-edge window. The card is anchored to the
    // bottom of this box, so the box must be pinned to the same viewport used
    // by popoverLayout or the card is painted one inset too high and drops a
    // frame later.
    const { width, height } = Dimensions.get("window")
    await render(<Harness placement="up" />)

    expect(screen.getByTestId("popover-root")).toHaveStyle({
      position: "absolute",
      top: 0,
      left: 0,
      width,
      height,
    })
  })
})

describe("popoverLayout", () => {
  const viewport = { width: 390, height: 844, keyboardInset: 0 }
  it("anchors above the trigger when placement is up", () => {
    const layout = popoverLayout({ x: 20, y: 760, width: 80, height: 32 }, "up", viewport)
    expect(layout).toMatchObject({ width: 288, left: 20, bottom: 90, top: undefined })
    expect(layout.maxHeight).toBe(746)
  })

  it("anchors below the trigger and clamps the card to the screen", () => {
    const layout = popoverLayout({ x: 380, y: 40, width: 40, height: 32 }, "down", viewport)
    expect(layout.width).toBe(288)
    expect(layout.left).toBe(94)
    expect(layout.top).toBe(78)
    expect(layout.maxHeight).toBe(758)
  })

  it("uses the trigger fallback only when no anchor exists", () => {
    const up = popoverLayout(null, "up", viewport)
    const down = popoverLayout(null, "down", viewport)
    expect(up.bottom).toBe(166)
    expect(down.top).toBe(86)
  })

  it("lifts the card above an open keyboard", () => {
    const withKeyboard = popoverLayout(
      { x: 20, y: 760, width: 80, height: 32 },
      "up",
      { ...viewport, keyboardInset: 300 },
    )
    const withoutKeyboard = popoverLayout({ x: 20, y: 760, width: 80, height: 32 }, "up", viewport)
    expect(withKeyboard.bottom).toBeGreaterThan(withoutKeyboard.bottom!)
  })
})

function HookHarness() {
  const popover = usePopover()
  return (
    <View>
      <Pressable ref={popover.triggerRef} testID="trigger" onPress={popover.toggle}>
        <Text>{popover.open ? "open" : "closed"}</Text>
      </Pressable>
    </View>
  )
}

describe("usePopover", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it("opens immediately and still works when measurement never answers", async () => {
    jest.useFakeTimers()
    await render(<HookHarness />)
    const trigger = screen.getByTestId("trigger")
    // RNTL's host ref answers measureInWindow but never invokes the callback.
    ;(trigger as unknown as { measureInWindow: () => void }).measureInWindow = jest.fn()

    await fireEvent.press(trigger)
    expect(screen.getByText("open")).toBeOnTheScreen()
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(screen.getByText("open")).toBeOnTheScreen()

    await fireEvent.press(trigger)
    expect(screen.getByText("closed")).toBeOnTheScreen()
  })

  it("opens with the measured anchor and ignores a late fallback", async () => {
    jest.useFakeTimers()
    await render(<HookHarness />)
    const trigger = screen.getByTestId("trigger")
    ;(trigger as unknown as {
      measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void
    }).measureInWindow = (callback) => callback(12, 100, 80, 32)

    await fireEvent.press(trigger)
    expect(screen.getByText("open")).toBeOnTheScreen()
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(screen.getByText("open")).toBeOnTheScreen()
  })

  it("lifts an open card when the search field opens the keyboard", async () => {
    const listeners = new Map<string, (event: { endCoordinates: { height: number } }) => void>()
    const spy = jest.spyOn(Keyboard, "addListener").mockImplementation((event, callback) => {
      listeners.set(event, callback as unknown as (event: { endCoordinates: { height: number } }) => void)
      return { remove: jest.fn() } as never
    })
    await render(<Harness placement="up" anchorValue={{ x: 12, y: 1200, width: 80, height: 32 }} />)
    const card = screen.getByTestId("popover-card")
    const before = StyleSheet.flatten(card.props.style).bottom as number
    const listener = listeners.get("keyboardWillShow") ?? listeners.get("keyboardDidShow")
    expect(listener).toBeDefined()
    await act(async () => {
      listener!({ endCoordinates: { height: 300 } })
    })
    const after = StyleSheet.flatten(screen.getByTestId("popover-card").props.style).bottom as number
    expect(after).toBeGreaterThan(before)
    spy.mockRestore()
  })

  it("reveals the fallback card only after the measurement window", async () => {
    jest.useFakeTimers()
    await render(<Harness anchorValue={null} />)
    const card = screen.getByTestId("popover-card")
    expect(card).toHaveStyle({ opacity: 0 })
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(card).toHaveStyle({ opacity: 1 })
  })
})

function MeasuredHarness({ onReady }: { onReady: (popover: ReturnType<typeof usePopover>) => void }) {
  const popover = usePopover()
  useEffect(() => {
    ;(popover.triggerRef as unknown as { current: unknown }).current = {
      measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
        callback(12, 100, 80, 32),
    }
    onReady(popover)
  }, [onReady, popover])
  return (
    <Pressable testID="measured-trigger" onPress={popover.toggle}>
      <Text>{popover.open ? "open" : "closed"}</Text>
    </Pressable>
  )
}

it("uses the measured callback to place the first open", async () => {
  jest.useFakeTimers()
  let popover: ReturnType<typeof usePopover> | null = null
  const ready = (value: ReturnType<typeof usePopover>): void => {
    popover = value
  }
  await render(<MeasuredHarness onReady={ready} />)
  await act(async () => {
    ;(popover as unknown as ReturnType<typeof usePopover>).show()
  })
  expect(screen.getByText("open")).toBeOnTheScreen()
  expect((popover as unknown as ReturnType<typeof usePopover>).anchor).toEqual({
    x: 12,
    y: 100,
    width: 80,
    height: 32,
  })
  jest.useRealTimers()
})

function NoNodeHarness() {
  const popover = usePopover()
  return (
    <Pressable testID="no-node-trigger" onPress={popover.toggle}>
      <Text>{popover.open ? "open" : "closed"}</Text>
    </Pressable>
  )
}

it("opens with the fallback when the trigger ref is missing", async () => {
  await render(<NoNodeHarness />)
  await fireEvent.press(screen.getByTestId("no-node-trigger"))
  expect(screen.getByText("open")).toBeOnTheScreen()
})
