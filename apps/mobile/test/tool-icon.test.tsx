import { render, screen } from "@testing-library/react-native"
import type { ToolIcon as ToolIconName } from "@masterhand/client-core"
import { ToolIcon } from "../src/components/ToolIcon"

/**
 * The tool glyph set is the mobile mirror of the web `ToolIcon` (#123): one
 * vector glyph per semantic icon, so read/write never fall back to a
 * font-dependent unicode approximation.
 */
describe("ToolIcon", () => {
  it.each([
    "terminal",
    "file",
    "pencil",
    "diff",
    "search",
    "globe",
    "checklist",
    "question",
    "tool",
  ] satisfies ToolIconName[])("renders the %s glyph", async (icon) => {
    await render(<ToolIcon icon={icon} color="#000000" />)

    expect(screen.root).toBeTruthy()
  })
})
