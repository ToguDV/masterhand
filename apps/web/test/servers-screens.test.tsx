// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createProfile, type ServerProfile } from "../src/servers"
import { ServerStatus } from "../src/components/ServerBits"
import { ServersScreen } from "../src/components/ServersScreen"
import { ServerSwitcher } from "../src/components/ServerSwitcher"
import { SettingsDialog } from "../src/components/SettingsPanel"

afterEach(cleanup)

function profile(overrides: Partial<ServerProfile> = {}): ServerProfile {
  return {
    ...createProfile({ url: "https://home.example.com", label: "Home" }),
    ...overrides,
  }
}

const noop = () => {}

describe("ServerStatus", () => {
  it("renders the approved glyph vocabulary with the status text", () => {
    const { rerender } = render(<ServerStatus status="connected" />)
    expect(screen.getByText("Connected")).toBeTruthy()
    expect(document.querySelector(".mh-status--connected")).toBeTruthy()

    rerender(<ServerStatus status="saved" />)
    expect(screen.getByText("Saved")).toBeTruthy()
    expect(document.querySelector(".mh-status--idle")).toBeTruthy()

    rerender(<ServerStatus status="expired" />)
    expect(screen.getByText("Expired")).toBeTruthy()
    expect(document.querySelector(".mh-status--expired")).toBeTruthy()

    rerender(<ServerStatus status="connecting" />)
    expect(screen.getByText("Connecting")).toBeTruthy()
    expect(document.querySelector(".mh-status--connecting")).toBeTruthy()
  })
})

describe("ServersScreen", () => {
  it("prefills the current origin and connects the first server", () => {
    const onSubmit = vi.fn()
    render(
      <ServersScreen
        profiles={[]}
        activeID={null}
        initialUrl="https://masterhand.example.com"
        busy={false}
        error={null}
        notice={null}
        connecting={null}
        reauthProfile={null}
        onSubmit={onSubmit}
        onSelect={noop}
        onCancel={noop}
        onCancelConnect={noop}
      />,
    )

    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe(
      "https://masterhand.example.com",
    )
    // A remote target must not attract the serving origin's saved password.
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("off")
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } })
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Home" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    expect(onSubmit).toHaveBeenCalledWith(
      "first-run",
      { url: "https://masterhand.example.com", label: "Home", password: "hunter2" },
    )
  })

  it("rejects a duplicate server and a remote http URL before submitting", () => {
    const onSubmit = vi.fn()
    render(
      <ServersScreen
        profiles={[profile()]}
        activeID={null}
        initialUrl=""
        busy={false}
        error={null}
        notice={null}
        connecting={null}
        reauthProfile={null}
        onSubmit={onSubmit}
        onSelect={noop}
        onCancel={noop}
        onCancelConnect={noop}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Add another server/ }))
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://home.example.com/" },
    })
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(screen.getByText("This server is already saved.")).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "http://remote.example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(screen.getByText(/Use https/)).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("lists saved servers with status, selects one and shows the re-auth error inline", () => {
    const home = profile()
    const studio = profile({ id: "studio", url: "https://studio.example.com", label: "Studio" })
    const expired = profile({
      id: "vps",
      url: "https://vps.example.com",
      label: "VPS",
      expired: true,
    })
    const onSelect = vi.fn()
    const { rerender } = render(
      <ServersScreen
        profiles={[home, studio, expired]}
        activeID={home.id}
        initialUrl=""
        busy={false}
        error={null}
        notice={null}
        connecting={null}
        reauthProfile={null}
        onSubmit={noop}
        onSelect={onSelect}
        onCancel={noop}
        onCancelConnect={noop}
      />,
    )

    expect(screen.getByText("Home")).toBeTruthy()
    expect(screen.getByText("Studio")).toBeTruthy()
    expect(screen.getByText("VPS")).toBeTruthy()
    expect(screen.getAllByText("Saved")).toHaveLength(2)
    expect(screen.getByText("Expired")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Studio/ }))
    expect(onSelect).toHaveBeenCalledWith(studio)

    rerender(
      <ServersScreen
        profiles={[home, studio, expired]}
        activeID={home.id}
        initialUrl=""
        busy={false}
        error="Wrong password. Try again."
        notice={null}
        connecting={null}
        reauthProfile={expired}
        onSubmit={noop}
        onSelect={onSelect}
        onCancel={noop}
        onCancelConnect={noop}
      />,
    )
    expect(screen.getByRole("heading", { name: "Reconnect to VPS" })).toBeTruthy()
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("current-password")
    expect(screen.getByRole("alert").textContent).toContain("Wrong password. Try again.")
  })

  it("shows a failed switch error on the list, not only inside forms", () => {
    const home = profile()
    render(
      <ServersScreen
        profiles={[home]}
        activeID={null}
        initialUrl=""
        busy={false}
        error="The saved session expired. Enter the password again."
        notice={null}
        connecting={null}
        reauthProfile={null}
        onSubmit={noop}
        onSelect={noop}
        onCancel={noop}
        onCancelConnect={noop}
      />,
    )

    const alert = screen.getByRole("alert")
    expect(alert.textContent).toContain("saved session expired")
    expect(screen.getByText("Home")).toBeTruthy()
  })

  it("renders the connecting transition with its label and a cancel action", () => {
    const onCancelConnect = vi.fn()
    render(
      <ServersScreen
        profiles={[profile()]}
        activeID={null}
        initialUrl=""
        busy
        error={null}
        notice={null}
        connecting={{ label: "Studio", url: "https://studio.example.com" }}
        reauthProfile={null}
        onSubmit={noop}
        onSelect={noop}
        onCancel={noop}
        onCancelConnect={onCancelConnect}
      />,
    )

    expect(screen.getByRole("status").textContent).toContain("Connecting to Studio")
    expect(document.querySelector(".mh-srv-spin")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancelConnect).toHaveBeenCalled()
  })
})

describe("ServerSwitcher", () => {
  it("switches server from the sidebar popover and exposes manage/add", () => {
    const home = profile()
    const studio = profile({ id: "studio", url: "https://studio.example.com", label: "Studio" })
    const onSwitch = vi.fn()
    const onManage = vi.fn()
    const onAdd = vi.fn()
    render(
      <ServerSwitcher
        profiles={[home, studio]}
        activeProfile={home}
        variant="sidebar"
        onSwitch={onSwitch}
        onManage={onManage}
        onAdd={onAdd}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Server: Home" }))
    expect(screen.getByRole("dialog", { name: "Servers" })).toBeTruthy()
    expect(screen.getByText("Connected")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Studio/ }))
    expect(onSwitch).toHaveBeenCalledWith(studio)

    fireEvent.click(screen.getByRole("button", { name: "Server: Home" }))
    fireEvent.click(screen.getByRole("button", { name: /Manage servers/ }))
    expect(onManage).toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Server: Home" }))
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Servers" }), { key: "Escape" })
    expect(screen.queryByRole("dialog", { name: "Servers" })).toBeNull()
  })

  it("opens the mobile bottom sheet and adds a server", () => {
    const home = profile()
    const onAdd = vi.fn()
    render(
      <ServerSwitcher
        profiles={[home]}
        activeProfile={home}
        variant="mobile"
        onSwitch={noop}
        onManage={noop}
        onAdd={onAdd}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Server: Home" }))
    expect(screen.getByRole("dialog", { name: "Servers" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Add another server/ }))
    expect(onAdd).toHaveBeenCalled()
  })
})

describe("Settings > Servers", () => {
  const servers = (overrides: Partial<NonNullable<Parameters<typeof SettingsDialog>[0]["servers"]>> = {}) => ({
    profiles: [profile(), profile({ id: "studio", url: "https://studio.example.com", label: "Studio" })],
    activeID: null as string | null,
    onRename: vi.fn(),
    onDisconnect: vi.fn(),
    onRemove: vi.fn(),
    onAdd: vi.fn(),
    ...overrides,
  })

  it("renames and disconnects a profile", () => {
    const props = servers()
    render(
      <SettingsDialog
        mode="light"
        onSelectMode={noop}
        palette="paper"
        onSelectPalette={noop}
        onSignOut={noop}
        onClose={noop}
        initialModule="servers"
        servers={props}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Rename Home" }))
    fireEvent.change(screen.getByLabelText("Name for Home"), { target: { value: "Home lab" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(props.onRename).toHaveBeenCalledWith(props.profiles[0], "Home lab")

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Home" }))
    expect(props.onDisconnect).toHaveBeenCalledWith(props.profiles[0])
  })

  it("confirms before removing a profile", () => {
    const props = servers()
    render(
      <SettingsDialog
        mode="light"
        onSelectMode={noop}
        palette="paper"
        onSelectPalette={noop}
        onSignOut={noop}
        onClose={noop}
        initialModule="servers"
        servers={props}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Remove Studio" }))
    const confirm = screen.getByRole("dialog", { name: "Remove Studio" })
    fireEvent.keyDown(confirm, { key: "Escape" })
    expect(screen.queryByRole("dialog", { name: "Remove Studio" })).toBeNull()
    // Escape closed only the confirmation, not the Settings dialog behind it.
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Remove Studio" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove" }))
    expect(props.onRemove).toHaveBeenCalledWith(props.profiles[1])
  })

  it("adds a server from the module", () => {
    const props = servers()
    render(
      <SettingsDialog
        mode="light"
        onSelectMode={noop}
        palette="paper"
        onSelectPalette={noop}
        onSignOut={noop}
        onClose={noop}
        initialModule="servers"
        servers={props}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Add server" }))
    expect(props.onAdd).toHaveBeenCalled()
  })
})
