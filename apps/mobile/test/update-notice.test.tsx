import { render, screen, waitFor } from "@testing-library/react-native"
import { AboutSection, UpdateBanner } from "../src/components/UpdateNotice"
import { ThemeProvider } from "../src/theme"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

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

describe("UpdateBanner", () => {
  it("offers F-Droid when the BFF reports a newer release", async () => {
    const client = fakeClient()
    client.api.update.check.mockResolvedValue({
      latest: { version: "0.2.0", tag: "v0.2.0", publishedAt: null, notes: null },
    })
    await render(
      <Harness client={client}>
        <UpdateBanner client={client} />
      </Harness>,
    )
    await waitFor(() => expect(screen.getByText(/New version 0\.2\.0 available/)).toBeTruthy())
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
    expect(screen.queryByText(/New version/)).toBeNull()
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
  })
})
