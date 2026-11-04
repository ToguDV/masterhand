// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it } from "vitest"
import type { BffStatus, VersionRelease } from "@masterhand/client-core"
import { UpdateNotices } from "../src/components/UpdateNotice"

const STATUS: BffStatus = { ok: true, version: "0.6.0", build: "build-a" }
const LATEST: VersionRelease = {
  version: "0.7.0",
  tag: "v0.7.0",
  publishedAt: null,
  notes: null,
}

function Harness({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

afterEach(() => {
  cleanup()
})

describe("UpdateNotices", () => {
  it("shows the release with an action and skip, never a deployment command", () => {
    render(
      <Harness>
        <UpdateNotices status={STATUS} latest={LATEST} />
      </Harness>,
    )

    expect(screen.getByText(/MasterHand 0\.7\.0 is available/)).toBeTruthy()
    expect(screen.getByText("Skip this version")).toBeTruthy()
    expect(screen.queryByText("Copy")).toBeNull()
    expect(screen.queryByText(/docker compose/)).toBeNull()
    // No updater in this status: the copy points at the deployment, not a command.
    expect(screen.getByText(/usual deployment procedure/)).toBeTruthy()
  })

  it("stays hidden when automatic checks are off", () => {
    render(
      <Harness>
        <UpdateNotices status={STATUS} latest={LATEST} checksEnabled={false} />
      </Harness>,
    )
    expect(screen.queryByText(/is available/)).toBeNull()
  })
})

