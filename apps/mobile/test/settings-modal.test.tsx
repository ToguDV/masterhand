import { Alert } from "react-native"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react-native"
import { SettingsModal } from "../src/components/SettingsModal"
import { ThemeProvider, useTheme } from "../src/theme"
import { saveTheme } from "../src/storage"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

jest.mock("../src/storage", () => ({
  loadTheme: jest.fn(async () => null),
  saveTheme: jest.fn(async () => {}),
  clearTheme: jest.fn(async () => {}),
}))

const mockedSave = saveTheme as jest.Mock

/** Drives the modal through the real theme provider, as the app does. */
function Harness({
  client,
  onClose = jest.fn(),
}: {
  client: ReturnType<typeof fakeClient>
  onClose?: () => void
}) {
  const { mode, setMode } = useTheme()
  return (
    <SettingsModal
      visible
      client={client}
      mode={mode}
      onSelectMode={setMode}
      onClose={onClose}
    />
  )
}

async function setup(
  configure?: (client: ReturnType<typeof fakeClient>) => void,
  props: { onClose?: () => void } = {},
) {
  const client = fakeClient()
  configure?.(client)
  const queryClient = makeQueryClient()
  await render(
    <QueryWrapper client={queryClient}>
      <ThemeProvider>
        <Harness client={client} {...props} />
      </ThemeProvider>
    </QueryWrapper>,
  )
  return { client }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("SettingsModal (#119)", () => {
  it("shows the theme droplets and the active selection", async () => {
    await setup()

    expect(screen.getByText("Appearance")).toBeOnTheScreen()
    expect(screen.getByText("Theme color")).toBeOnTheScreen()
    expect(screen.queryByLabelText("System")).toBeNull()
    // No stored choice: the modal starts on the resolved system theme (light here).
    expect(screen.getByLabelText("Light").props.accessibilityState?.checked).toBe(true)
    expect(screen.getByLabelText("Dark").props.accessibilityState?.checked).toBe(false)
  })

  it("persists an explicit theme", async () => {
    await setup()

    await fireEvent.press(screen.getByLabelText("Dark"))
    expect(mockedSave).toHaveBeenCalledWith("dark")
    expect(screen.getByLabelText("Dark").props.accessibilityState?.checked).toBe(true)

    await fireEvent.press(screen.getByLabelText("Light"))
    expect(mockedSave).toHaveBeenCalledWith("light")
    expect(screen.getByLabelText("Light").props.accessibilityState?.checked).toBe(true)
  })

  it("closes from the header button", async () => {
    const onClose = jest.fn()
    await setup(undefined, { onClose })

    await fireEvent.press(screen.getByLabelText("Close settings"))
    expect(onClose).toHaveBeenCalled()
  })
})

describe("SettingsModal providers (#128)", () => {
  it("pins OpenCode Go first and connects a key", async () => {
    const { client } = await setup((c) => {
      c.api.integrations.mockResolvedValue([
        { id: "anthropic", name: "Anthropic", methods: [{ id: "key", type: "key", label: "API key" }], connections: [] },
        { id: "opencode-go", name: "OpenCode Go", methods: [{ id: "key", type: "key", label: "API key" }], connections: [] },
      ])
      c.api.credentials.mockResolvedValue([])
    })

    // OpenCode Go is highlighted first (its Connect button comes first).
    const connectButtons = await screen.findAllByLabelText(/^Connect /)
    expect(connectButtons[0]?.props.accessibilityLabel).toBe("Connect OpenCode Go")

    await fireEvent.press(screen.getByLabelText("Connect OpenCode Go"))
    await fireEvent.changeText(screen.getByTestId("provider-key-input"), "sk-secret")
    await fireEvent.press(screen.getByLabelText("Save key"))

    await waitFor(() =>
      expect(client.api.connectIntegrationKey).toHaveBeenCalledWith("opencode-go", { key: "sk-secret" }),
    )
  })

  it("shows a connected provider and disconnects it with confirmation", async () => {
    const { client } = await setup((c) => {
      c.api.integrations.mockResolvedValue([
        {
          id: "opencode-go",
          name: "OpenCode Go",
          methods: [{ id: "key", type: "key", label: "API key" }],
          connections: [{ type: "credential", credentialID: "cred_1", label: "Personal", method: "key" }],
        },
      ])
      c.api.credentials.mockResolvedValue([
        { id: "cred_1", integrationID: "opencode-go", label: "Personal", active: true },
      ])
    })

    expect(await screen.findByText("Connected")).toBeOnTheScreen()

    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {})
    await fireEvent.press(screen.getByLabelText("Disconnect Personal"))

    const destructive = alert.mock.calls[0]?.[2]?.find((button) => button.style === "destructive")
    destructive?.onPress?.()

    await waitFor(() => expect(client.api.removeCredential).toHaveBeenCalledWith("cred_1"))
    alert.mockRestore()
  })

  it("keeps oauth providers informational", async () => {
    await setup((c) => {
      c.api.integrations.mockResolvedValue([
        { id: "github", name: "GitHub", methods: [{ id: "oauth", type: "oauth", label: "Sign in" }], connections: [] },
      ])
      c.api.credentials.mockResolvedValue([])
    })

    expect(await screen.findByText(/opencode CLI\/TUI/)).toBeOnTheScreen()
    expect(screen.queryByLabelText("Connect GitHub")).toBeNull()
  })

  it("shows five providers by default, expands and searches (#128)", async () => {
    await setup((c) => {
      c.api.integrations.mockResolvedValue(
        ["opencode-go", "anthropic", "openai", "google", "github", "gitlab", "openrouter"].map((id) => ({
          id,
          name: id,
          methods: [{ id: "key", type: "key", label: "API key" }],
          connections: [],
        })),
      )
      c.api.credentials.mockResolvedValue([])
    })

    // First five only, each with an avatar.
    expect(await screen.findAllByTestId("provider-avatar")).toHaveLength(5)

    await fireEvent.press(screen.getByLabelText("Show all 7 providers"))
    await waitFor(() => expect(screen.getAllByTestId("provider-avatar")).toHaveLength(7))

    // The search filters across the whole catalog (not only the visible page).
    await fireEvent.changeText(screen.getByTestId("provider-search"), "git")
    await waitFor(() => expect(screen.getAllByTestId("provider-avatar")).toHaveLength(2))
    expect(screen.queryByTestId("integration-opencode-go")).toBeNull()
    expect(screen.getByTestId("integration-github")).toBeOnTheScreen()
    expect(screen.getByTestId("integration-gitlab")).toBeOnTheScreen()
  })

  it("renders the original brand mark, a metadata icon or the monogram (#128)", async () => {
    await setup((c) => {
      c.api.integrations.mockResolvedValue([
        { id: "anthropic", name: "Anthropic", methods: [{ id: "key", type: "key", label: "API key" }], connections: [] },
        { id: "github", name: "GitHub", methods: [{ id: "oauth", type: "oauth", label: "Sign in" }], connections: [] },
        {
          id: "acme",
          name: "Acme",
          methods: [{ id: "key", type: "key", label: "API key" }],
          connections: [],
          icon: "https://example.com/acme.svg",
        },
      ])
      c.api.credentials.mockResolvedValue([])
    })

    // Vendored original logo: an inline SVG instead of the monogram letter.
    const anthropic = await screen.findByTestId("integration-anthropic")
    expect(within(anthropic).getByTestId("provider-brand-icon")).toBeOnTheScreen()
    expect(within(anthropic).queryByText("A")).toBeNull()

    // No vendored logo: deterministic monogram.
    const github = screen.getByTestId("integration-github")
    expect(within(github).queryByTestId("provider-brand-icon")).toBeNull()
    expect(within(github).getByText("G")).toBeOnTheScreen()

    // An explicit metadata icon wins over the vendored/fallback glyph.
    const acme = screen.getByTestId("integration-acme")
    expect(within(acme).queryByTestId("provider-brand-icon")).toBeNull()
    expect(within(acme).queryByText("A")).toBeNull()
    expect(within(acme).getByTestId("provider-avatar").props.source).toEqual({
      uri: "https://example.com/acme.svg",
    })
  })
})
