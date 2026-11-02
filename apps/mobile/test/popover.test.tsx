import { useState } from "react"
import { Text } from "react-native"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { Popover, type PopoverAnchor } from "../src/components/Popover"

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
})
