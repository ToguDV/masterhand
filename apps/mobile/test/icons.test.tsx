import { render, screen } from "@testing-library/react-native"
import * as icons from "../src/components/icons"

/**
 * The icon set is the mobile mirror of the web `icons.tsx` (#92). Rendering
 * every glyph keeps the module covered and catches a name that no longer maps
 * to a real vector-icons entry.
 */
describe("icons", () => {
  it("renders every glyph in the shared set", async () => {
    const glyphs = Object.values(icons).filter(
      (value): value is (props: { color?: string }) => React.ReactElement => typeof value === "function",
    )
    expect(glyphs.length).toBeGreaterThan(0)

    const view = await render(
      <>
        {glyphs.map((Icon, index) => (
          <Icon key={index} color="#000000" />
        ))}
      </>,
    )

    expect(screen.root).toBeTruthy()
    view.unmount()
  })
})
