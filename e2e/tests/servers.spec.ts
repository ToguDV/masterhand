import { expect, test } from "../fixtures"
import { addRemoteServer, addWorkspace, login, newSession, switchServer } from "./helpers"

test("first run connects the current origin and remembers it", async ({ page }) => {
  await page.goto("/")
  const origin = new URL(page.url()).origin

  await expect(page.locator("#server-url")).toHaveValue(origin)
  await page.locator("#password").fill("e2e-password")
  await page.getByRole("button", { name: "Connect", exact: true }).click()

  await expect(page.getByRole("button", { name: "New session" })).toBeVisible()
  await expect(page.getByRole("button", { name: /^Server: / })).toBeVisible()
})

test("a saved session restores without asking for the password again", async ({ page }) => {
  await login(page)
  await page.reload()

  await expect(page.getByRole("button", { name: "New session" })).toBeVisible()
  await expect(page.locator("#password")).toHaveCount(0)
  await expect(page.getByRole("button", { name: /^Server: / })).toBeVisible()
})

test("adds a remote server, switches and persists the active profile", async ({ page, harness }) => {
  await login(page)
  const localLabel = new URL(harness.bffURL).hostname
  const remoteURL = harness.bffURL.replace("127.0.0.1", "localhost")

  await addRemoteServer(page, { url: remoteURL, name: "Remote" })
  await expect(page.getByRole("button", { name: "Server: Remote" })).toBeVisible()
  await expect(page).toHaveTitle("Remote · MasterHand")

  await switchServer(page, localLabel)
  await expect(page.getByRole("button", { name: `Server: ${localLabel}` })).toBeVisible()

  await page.reload()
  await expect(page.getByRole("button", { name: `Server: ${localLabel}` })).toBeVisible()

  await switchServer(page, "Remote")
  await expect(page.getByRole("button", { name: "Server: Remote" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("button", { name: "Server: Remote" })).toBeVisible()
})

test("never assigns the serving origin's legacy preferences to a remote first profile", async ({
  page,
  harness,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("masterhand.workspace", "ws-legacy")
    localStorage.setItem("masterhand.autoAcceptSessions", JSON.stringify(["session-legacy"]))
    localStorage.setItem("masterhand.lastSeenSessions", JSON.stringify({ "session-legacy": 1 }))
  })
  await page.goto("/")
  await page.locator("#server-url").fill(harness.bffURL.replace("127.0.0.1", "localhost"))
  await page.locator("#server-name").fill("Remote")
  await page.locator("#password").fill("e2e-password")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByRole("button", { name: "New session" })).toBeVisible()

  const state = await page.evaluate(() => {
    const raw = localStorage.getItem("masterhand.servers")
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    const profiles = Array.isArray(parsed)
      ? parsed
      : ((parsed as { profiles?: Array<{ lastWorkspaceID?: string | null }> } | null)?.profiles ?? [])
    return {
      legacyWorkspace: localStorage.getItem("masterhand.workspace"),
      legacyAutoAccept: localStorage.getItem("masterhand.autoAcceptSessions"),
      legacySeen: localStorage.getItem("masterhand.lastSeenSessions"),
      lastWorkspaceID: profiles[0]?.lastWorkspaceID ?? null,
      scopedAutoAccept: Object.keys(localStorage)
        .filter((key) => key.startsWith("masterhand.autoAcceptSessions."))
        .map((key) => localStorage.getItem(key)),
    }
  })

  // The legacy keys still belong to the serving origin: they are neither
  // copied into the remote profile nor deleted from storage.
  expect(state.legacyWorkspace).toBe("ws-legacy")
  expect(state.legacyAutoAccept).toBe(JSON.stringify(["session-legacy"]))
  expect(state.legacySeen).toBe(JSON.stringify({ "session-legacy": 1 }))
  expect(state.lastWorkspaceID).toBeNull()
  expect(state.scopedAutoAccept).not.toContain(JSON.stringify(["session-legacy"]))
})

test("keeps a wrong password inline on the add form", async ({ page, harness }) => {
  await page.goto("/")
  await page.locator("#server-url").fill(harness.bffURL.replace("127.0.0.1", "localhost"))
  await page.locator("#server-name").fill("Remote")
  await page.locator("#password").fill("definitely-wrong")
  await page.getByRole("button", { name: "Connect", exact: true }).click()

  await expect(page.getByText("Wrong password. Try again.")).toBeVisible()
  await expect(page.locator("#password")).toBeVisible()
  await expect(page.locator("#server-url")).toHaveValue(
    harness.bffURL.replace("127.0.0.1", "localhost"),
  )
})

test("switching servers never leaks the previous server's data", async ({ page, harness }) => {
  await login(page)
  const localWorkspace = await addWorkspace(page, `local-${Date.now()}`)
  await newSession(page)
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()

  const remoteBase = harness.bffURL.replace("127.0.0.1", "localhost")
  let bearer: string | undefined
  let cookie: string | undefined
  await page.route(`${remoteBase}/api/workspaces`, async (route) => {
    bearer = route.request().headers()["authorization"]
    cookie = route.request().headers()["cookie"]
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        workspaces: [
          { id: "remote-ws", name: "remote-only", path: "/workspace/remote-only", createdAt: 0 },
        ],
      }),
    })
  })
  await page.route(`${remoteBase}/api/workspaces/remote-ws/sessions*`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ sessions: [] }),
    })
  })

  await addRemoteServer(page, { url: remoteBase, name: "Remote" })

  // The remote profile's own workspace is shown, from a bearer-authenticated
  // request (no cookie from the serving origin is reused).
  await expect(page.getByRole("button", { name: "Workspace" })).toContainText("remote-only")
  expect(bearer).toMatch(/^Bearer /)
  expect(cookie).toBeUndefined()

  // Nothing from the previous server's cache survives the switch.
  await expect(page.getByText(localWorkspace)).toBeHidden()
  await expect(page.getByText("No sessions yet.")).toBeVisible()
})
