import { render, screen } from "@testing-library/react-native"
import { ThemeProvider, palettes } from "../src/theme"
import { CodeBlock, DiffView } from "../src/components/tools/ToolBodies"

jest.mock("../src/storage", () => ({
  loadTheme: jest.fn(async () => null),
  loadPalette: jest.fn(async () => null),
  savePalette: jest.fn(async () => {}),
  clearPalette: jest.fn(async () => {}),
  saveTheme: jest.fn(async () => {}),
  clearTheme: jest.fn(async () => {}),
}))

async function setup(ui: React.ReactElement) {
  await render(
    <ThemeProvider>
      {ui}
    </ThemeProvider>,
  )
}

describe("highlighted code (#123)", () => {
  it("colors keywords in tool code blocks by file language", async () => {
    await setup(<CodeBlock text="export const app = 1" language="src/app.ts" numbered={false} />)

    const keyword = await screen.findByText("export")
    expect(keyword.props.style).toMatchObject({ color: palettes.light.syntax.keyword })
  })

  it("renders unknown languages plain", async () => {
    await setup(<CodeBlock text="a: 1" language="notes.yaml" numbered={false} />)

    expect(await screen.findByText("a: 1")).toBeOnTheScreen()
  })

  it("highlights context lines in diffs, never the add/remove rows", async () => {
    await setup(
      <DiffView
        language="src/app.ts"
        diff={[
          { kind: "context", text: "export const app = 1" },
          { kind: "add", text: "export const more = 3" },
        ]}
      />,
    )

    const keyword = await screen.findByText("export")
    expect(keyword.props.style).toMatchObject({ color: palettes.light.syntax.keyword })
    // The added row keeps its semantic color, not token colors.
    expect(screen.getByText("export const more = 3")).toBeOnTheScreen()
  })
})
