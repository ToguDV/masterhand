import { fireEvent, render, screen, waitFor, within } from "@testing-library/react-native"
import { ProvidersSection } from "../src/components/ProvidersSection"
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
        <ProvidersSection client={client} />
      </ThemeProvider>
    </QueryWrapper>,
  )
  return { client }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("ProvidersSection custom providers (#138)", () => {
  it("walks the whole add-provider form", async () => {
    const { client } = await setup((c) => {
      c.api.customProviders.mockResolvedValue([])
    })

    await fireEvent.press(await screen.findByLabelText("Add provider"))
    const dialog = screen.getByLabelText("Add OpenAI-compatible provider")

    await fireEvent.changeText(within(dialog).getByLabelText(/^Display name$/), "Acme AI")
    expect(within(dialog).getByLabelText("Provider id").props.value).toBe("acme-ai")
    // Editing the id marks it as touched (stops deriving from the name).
    await fireEvent.changeText(within(dialog).getByLabelText("Provider id"), "acme-custom")
    await fireEvent.changeText(within(dialog).getByLabelText(/^Display name$/), "Acme Renamed")
    expect(within(dialog).getByLabelText("Provider id").props.value).toBe("acme-custom")
    await fireEvent.changeText(within(dialog).getByLabelText("Base URL"), "https://api.acme.example/v1")
    await fireEvent.changeText(within(dialog).getByLabelText("API key"), "sk-secret")

    await fireEvent.changeText(within(dialog).getByLabelText("Model id"), "acme-coder")
    await fireEvent.changeText(within(dialog).getByLabelText("Model display name"), "Acme Coder")
    // A second model: added then removed.
    await fireEvent.press(within(dialog).getByLabelText("Add model"))
    const modelIds = within(dialog).getAllByLabelText("Model id")
    await fireEvent.changeText(modelIds[1]!, "acme-mini")
    await fireEvent.press(within(dialog).getAllByLabelText("Remove model")[1]!)

    // Advanced: transport, limits and headers.
    await fireEvent.press(within(dialog).getByLabelText("Advanced"))
    await fireEvent.press(within(dialog).getByLabelText("Responses (/v1/responses)"))
    await fireEvent.changeText(within(dialog).getByLabelText("Context tokens"), "128000")
    await fireEvent.changeText(within(dialog).getByLabelText("Output tokens"), "4096")
    await fireEvent.press(within(dialog).getByLabelText("Add header"))
    await fireEvent.changeText(within(dialog).getByLabelText("Header name"), "X-Key")
    await fireEvent.changeText(within(dialog).getByLabelText("Header value"), "value")
    await fireEvent.press(within(dialog).getByLabelText("Remove header"))
    await fireEvent.press(within(dialog).getByLabelText("Add header"))
    await fireEvent.changeText(within(dialog).getByLabelText("Header name"), "X-Keep")
    await fireEvent.changeText(within(dialog).getByLabelText("Header value"), "yes")
    // Collapsing advanced again (branch) before submitting.
    await fireEvent.press(within(dialog).getByLabelText("Advanced"))
    await fireEvent.press(within(dialog).getByLabelText("Advanced"))

    await fireEvent.press(within(dialog).getByLabelText("Save provider"))

    await waitFor(() =>
      expect(client.api.createCustomProvider).toHaveBeenCalledWith({
        id: "acme-custom",
        name: "Acme Renamed",
        baseURL: "https://api.acme.example/v1",
        package: "openai",
        models: [{ id: "acme-coder", name: "Acme Coder", context: 128000, output: 4096 }],
        headers: { "X-Keep": "yes" },
        key: "sk-secret",
      }),
    )
  })

  it("cancels, validates and surfaces a save error", async () => {
    const { client } = await setup((c) => {
      c.api.customProviders.mockResolvedValue([])
      c.api.createCustomProvider.mockRejectedValue(new Error("nope"))
    })

    await fireEvent.press(await screen.findByLabelText("Add provider"))
    const dialog = screen.getByLabelText("Add OpenAI-compatible provider")
    // An invalid id keeps submit disabled.
    await fireEvent.changeText(within(dialog).getByLabelText(/^Display name$/), "Bad Name")
    await fireEvent.changeText(within(dialog).getByLabelText("Provider id"), "bad id")
    await fireEvent.changeText(within(dialog).getByLabelText("Base URL"), "not-a-url")
    expect(within(dialog).getByLabelText("Save provider").props.accessibilityState?.disabled).toBe(true)

    await fireEvent.press(within(dialog).getByLabelText("Cancel add provider"))
    await waitFor(() => expect(screen.queryByLabelText("Add OpenAI-compatible provider")).toBeNull())

    // Reopen, fill valid data, and hit the error path.
    await fireEvent.press(screen.getByLabelText("Add provider"))
    const dialog2 = screen.getByLabelText("Add OpenAI-compatible provider")
    await fireEvent.changeText(within(dialog2).getByLabelText(/^Display name$/), "Acme")
    await fireEvent.changeText(within(dialog2).getByLabelText("Base URL"), "https://api.acme.example/v1")
    await fireEvent.changeText(within(dialog2).getByLabelText("Model id"), "m1")
    await fireEvent.press(within(dialog2).getByLabelText("Save provider"))
    await waitFor(() => expect(screen.getByText("Could not save the provider")).toBeOnTheScreen())
  })

  it("loads models from the provider automatically", async () => {
    const { client } = await setup((c) => {
      c.api.customProviders.mockResolvedValue([])
      c.api.listCustomProviderModels.mockResolvedValue([
        { id: "acme-coder", name: "Acme Coder" },
        { id: "acme-mini" },
      ])
    })

    await fireEvent.press(await screen.findByLabelText("Add provider"))
    const dialog = screen.getByLabelText("Add OpenAI-compatible provider")
    await fireEvent.changeText(within(dialog).getByLabelText(/^Display name$/), "Acme AI")
    await fireEvent.changeText(within(dialog).getByLabelText("Base URL"), "https://api.acme.example/v1")
    await fireEvent.changeText(within(dialog).getByLabelText("API key"), "sk-secret")

    // No model id typed: the debounced discovery fills the rows.
    await waitFor(() => expect(client.api.listCustomProviderModels).toHaveBeenCalled(), { timeout: 2000 })
    const ids = await waitFor(() => {
      const inputs = within(dialog).getAllByLabelText("Model id")
      expect(inputs).toHaveLength(2)
      return inputs
    })
    expect(ids[0]!.props.value).toBe("acme-coder")
    expect(ids[1]!.props.value).toBe("acme-mini")
    expect(within(dialog).getByText("2 models loaded from the provider.")).toBeOnTheScreen()
  })

  it("connects a stored custom provider", async () => {
    const { client } = await setup((c) => {
      c.api.customProviders.mockResolvedValue([
        { id: "acme", name: "Acme", baseURL: "https://api.acme.example/v1", package: "openai-compatible", models: [{ id: "m1" }] },
      ])
      c.api.integrations.mockResolvedValue([])
      c.api.credentials.mockResolvedValue([])
    })

    await fireEvent.press(await screen.findByLabelText("Connect Acme"))
    await fireEvent.changeText(screen.getByTestId("provider-key-input"), "sk-secret")
    await fireEvent.press(screen.getByLabelText("Save key"))
    await waitFor(() =>
      expect(client.api.connectIntegrationKey).toHaveBeenCalledWith("acme", { key: "sk-secret" }),
    )
  })

  it("shows a load error and a save notice", async () => {
    await setup((c) => {
      c.api.customProviders.mockRejectedValue(new Error("boom"))
    })
    expect(await screen.findByText("Could not load the custom providers.")).toBeOnTheScreen()
  })
})
