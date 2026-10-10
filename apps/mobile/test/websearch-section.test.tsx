import { fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import { Alert } from "react-native"
import { WebSearchSection } from "../src/components/WebSearchSection"
import { ThemeProvider } from "../src/theme"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

jest.mock("../src/storage", () => ({
  loadTheme: jest.fn(async () => null),
  loadPalette: jest.fn(async () => null),
  savePalette: jest.fn(async () => {}),
  clearPalette: jest.fn(async () => {}),
  saveTheme: jest.fn(async () => {}),
  clearTheme: jest.fn(async () => {}),
}))

async function setup(configure?: (client: ReturnType<typeof fakeClient>) => void) {
  const client = fakeClient()
  configure?.(client)
  await render(
    <QueryWrapper client={makeQueryClient()}>
      <ThemeProvider>
        <WebSearchSection client={client} />
      </ThemeProvider>
    </QueryWrapper>,
  )
  return { client }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("WebSearchSection", () => {
  it("shows the keyless default and switches the source", async () => {
    const { client } = await setup((c) => {
      c.api.websearchSources.mockResolvedValue([
        { id: "exa", name: "Exa", keyless: false },
        { id: "tinyfish", name: "TinyFish", keyless: true },
      ])
      c.api.websearchSettings.mockResolvedValue("tinyfish")
    })

    expect(await screen.findByText("No API key required")).toBeOnTheScreen()
    expect(screen.getByLabelText("TinyFish").props.accessibilityState?.checked).toBe(true)
    expect(screen.getByLabelText("Exa").props.accessibilityState?.checked).toBe(false)

    await fireEvent.press(screen.getByLabelText("Exa"))
    await waitFor(() => expect(client.api.saveWebsearchSettings).toHaveBeenCalledWith("exa"))

    await fireEvent.press(screen.getByLabelText("Automatic"))
    await waitFor(() => expect(client.api.saveWebsearchSettings).toHaveBeenCalledWith("random"))
  })

  it("connects a source key and disconnects it with confirmation", async () => {
    const { client } = await setup((c) => {
      c.api.websearchSources.mockResolvedValue([{ id: "tavily", name: "Tavily", keyless: false }])
      c.api.websearchSettings.mockResolvedValue("tavily")
      c.api.integrations
        .mockResolvedValueOnce([
          { id: "tavily", name: "Tavily", methods: [{ id: "key", type: "key", label: "API key" }], connections: [] },
        ])
        .mockResolvedValue([
          {
            id: "tavily",
            name: "Tavily",
            methods: [{ id: "key", type: "key", label: "API key" }],
            connections: [{ type: "credential", credentialID: "cred_1", label: "E2E" }],
          },
        ])
      c.api.credentials.mockResolvedValue([{ id: "cred_1", integrationID: "tavily", label: "E2E", active: true }])
    })

    await fireEvent.press(await screen.findByLabelText("Connect Tavily"))
    await fireEvent.changeText(screen.getByLabelText("API key"), "tvly-secret")
    await fireEvent.changeText(screen.getByLabelText("Key label"), "E2E")
    await fireEvent.press(screen.getByLabelText("Save key"))

    await waitFor(() =>
      expect(client.api.connectIntegrationKey).toHaveBeenCalledWith("tavily", { key: "tvly-secret", label: "E2E" }),
    )
    // The refresh reconciles the connection row.
    expect(await screen.findByText("Connected")).toBeOnTheScreen()

    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {})
    await fireEvent.press(screen.getByLabelText("Disconnect Tavily"))
    const destructive = alert.mock.calls[0]?.[2]?.find((button) => button.style === "destructive")
    destructive?.onPress?.()
    await waitFor(() => expect(client.api.removeCredential).toHaveBeenCalledWith("cred_1"))
    alert.mockRestore()
  })

  it("runs a test search and shows the answering source", async () => {
    const { client } = await setup((c) => {
      c.api.websearchSources.mockResolvedValue([{ id: "tinyfish", name: "TinyFish", keyless: true }])
      c.api.websearchSettings.mockResolvedValue("tinyfish")
      c.api.testWebsearch.mockResolvedValue({
        providerID: "tinyfish",
        results: [{ url: "https://a.example", title: "Effect documentation" }],
      })
    })

    await fireEvent.changeText(await screen.findByLabelText("Test search query"), "effect")
    await fireEvent.press(screen.getByLabelText("Run test search"))

    await waitFor(() => expect(client.api.testWebsearch).toHaveBeenCalledWith("effect"))
    expect(await screen.findByText("Effect documentation")).toBeOnTheScreen()
  })
})
