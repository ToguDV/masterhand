import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import { Linking } from "react-native"
import { AboutSection, UpdateBanner } from "../src/components/UpdateNotice"
import { openFdroidListing } from "../src/update"
import { ThemeProvider } from "../src/theme"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

jest.mock("../src/update", () => {
  const actual = jest.requireActual("../src/update")
  return { ...actual, openFdroidListing: jest.fn(async () => {}) }
})

// jest-expo reports the native version as "mock": pin the module so the
// installed build is the 0.1.0 baseline the banner compares against.
jest.mock("expo-application", () => ({
  nativeApplicationVersion: "0.1.0",
  nativeBuildVersion: "100",
}))

function Harness({
  client,
  children,
}: {
  client: ReturnType<typeof fakeClient>
  children: React.ReactNode
}) {
  const queryClient = makeQueryClient()
  return (
    <ThemeProvider>
      <QueryWrapper client={queryClient}>{children}</QueryWrapper>
    </ThemeProvider>
  )
}

function newerRelease(client: ReturnType<typeof fakeClient>) {
  client.api.update.check.mockResolvedValue({
    latest: { version: "0.2.0", tag: "v0.2.0", publishedAt: null, notes: null },
  })
}

describe("UpdateBanner", () => {
  it("offers F-Droid when the BFF reports a newer release", async () => {
    const client = fakeClient()
    newerRelease(client)
    await render(
      <Harness client={client}>
        <UpdateBanner client={client} />
      </Harness>,
    )
    await waitFor(() => expect(screen.getByText(/MasterHand 0\.2\.0 is available/)).toBeTruthy())
    expect(screen.getByLabelText("Open F-Droid")).toBeTruthy()
  })

  it("stays silent when no release is known", async () => {
    const client = fakeClient()
    await render(
      <Harness client={client}>
        <UpdateBanner client={client} />
      </Harness>,
    )
    await waitFor(() => expect(client.api.update.check).toHaveBeenCalled())
    expect(screen.queryByText(/is available/)).toBeNull()
  })

  it("stays silent for a dismissed version and never checks when disabled", async () => {
    const client = fakeClient()
    newerRelease(client)
    const first = await render(
      <Harness client={client}>
        <UpdateBanner client={client} dismissedTag="v0.2.0" />
      </Harness>,
    )
    await waitFor(() => expect(client.api.update.check).toHaveBeenCalled())
    expect(screen.queryByText(/is available/)).toBeNull()
    await first.unmount()

    const disabled = fakeClient()
    await render(
      <Harness client={disabled}>
        <UpdateBanner client={disabled} enabled={false} />
      </Harness>,
    )
    expect(disabled.api.update.check).not.toHaveBeenCalled()
  })

  it("persists 'Don't show again' through the callback", async () => {
    const client = fakeClient()
    newerRelease(client)
    const onDismiss = jest.fn()
    await render(
      <Harness client={client}>
        <UpdateBanner client={client} onDismiss={onDismiss} />
      </Harness>,
    )
    await waitFor(() => expect(screen.getByLabelText("Don't show again")).toBeTruthy())
    await fireEvent.press(screen.getByLabelText("Don't show again"))
    expect(onDismiss).toHaveBeenCalledWith("v0.2.0")
  })

  it("opens F-Droid and hides on Later", async () => {
    const client = fakeClient()
    newerRelease(client)
    const openListing = openFdroidListing as jest.Mock
    openListing.mockClear()
    await render(
      <Harness client={client}>
        <UpdateBanner client={client} />
      </Harness>,
    )
    await waitFor(() => expect(screen.getByLabelText("Open F-Droid")).toBeTruthy())
    await fireEvent.press(screen.getByLabelText("Open F-Droid"))
    expect(openListing).toHaveBeenCalled()

    await fireEvent.press(screen.getByLabelText("Later"))
    expect(screen.queryByText(/MasterHand 0\.2\.0 is available/)).toBeNull()
  })
})

describe("AboutSection", () => {
  it("shows the installed version with update actions", async () => {
    const client = fakeClient()
    await render(
      <Harness client={client}>
        <AboutSection client={client} />
      </Harness>,
    )
    // Under Jest the native module is absent, so the 0.1.0 baseline applies.
    expect(screen.getByText("Installed version")).toBeTruthy()
    expect(screen.getByText("0.1.0")).toBeTruthy()
    expect(screen.getByLabelText("Check for updates")).toBeTruthy()
    expect(screen.getByLabelText("Open F-Droid")).toBeTruthy()
    expect(screen.getByLabelText("Open F-Droid repository website")).toBeTruthy()

    const openSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined)
    const openListing = openFdroidListing as jest.Mock
    openListing.mockClear()
    await fireEvent.press(screen.getByLabelText("Open F-Droid"))
    expect(openListing).toHaveBeenCalled()
    await fireEvent.press(screen.getByLabelText("Open F-Droid repository website"))
    expect(openSpy).toHaveBeenCalledWith("https://togudv.github.io/masterhand/")
    openSpy.mockRestore()
  })

  it("toggles the automatic check and still allows a manual check", async () => {
    const client = fakeClient()
    const onToggleChecks = jest.fn()
    await render(
      <Harness client={client}>
        <AboutSection client={client} checksEnabled={false} onToggleChecks={onToggleChecks} />
      </Harness>,
    )
    expect(client.api.update.check).not.toHaveBeenCalled()
    await fireEvent(screen.getByLabelText("Check for updates automatically"), "valueChange", true)
    expect(onToggleChecks).toHaveBeenCalledWith(true)
    await fireEvent.press(screen.getByLabelText("Check for updates"))
    await waitFor(() => expect(client.api.update.check).toHaveBeenCalled())
    // Flush the manual response inside act before the test ends.
    await act(async () => {
      await Promise.resolve()
    })
  })
})
