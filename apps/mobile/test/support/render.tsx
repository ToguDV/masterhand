import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Client, PreviewStatus } from "@masterhand/client-core"

export const STOPPED_PREVIEW: PreviewStatus = { status: "stopped", url: null, port: null, error: null }

export function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
}

export function QueryWrapper({ client, children }: { client: QueryClient; children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

/**
 * A fake `Client` whose methods are `jest.fn`s, so a test can drive the real
 * hooks (`useQuery`-based) without a network. Assign results per test with
 * `client.api.agents.mockResolvedValue([...])`.
 */
export interface FakeClient {
  auth: { status: jest.Mock }
  api: {
    agents: jest.Mock
    commands: jest.Mock
    models: jest.Mock
    messages: jest.Mock
    prompt: jest.Mock
    runCommand: jest.Mock
    forkSession: jest.Mock
    removeSession: jest.Mock
    abortSession: jest.Mock
    preview: jest.Mock
    startPreview: jest.Mock
    stopPreview: jest.Mock
    audit: jest.Mock
    clearAudit: jest.Mock
    sessions: { list: jest.Mock; finish: jest.Mock }
  }
  workspaces: { list: jest.Mock; create: jest.Mock; remove: jest.Mock }
}

export function fakeClient(): FakeClient & Client {
  const client: FakeClient = {
    auth: { status: jest.fn(async () => ({ ok: true })) },
    api: {
      agents: jest.fn(async () => []),
      commands: jest.fn(async () => []),
      models: jest.fn(async () => ({ models: [], providers: [], defaultModel: null })),
      messages: jest.fn(async () => []),
      prompt: jest.fn(async () => {}),
      runCommand: jest.fn(async () => {}),
      forkSession: jest.fn(async () => ({ id: "fork_1" })),
      removeSession: jest.fn(async () => {}),
      abortSession: jest.fn(async () => {}),
      preview: jest.fn(async () => STOPPED_PREVIEW),
      startPreview: jest.fn(async () => STOPPED_PREVIEW),
      stopPreview: jest.fn(async () => {}),
      audit: jest.fn(async () => []),
      clearAudit: jest.fn(async () => {}),
      sessions: {
        list: jest.fn(async () => []),
        finish: jest.fn(async () => ({
          committed: true,
          pushed: false,
          prUrl: null,
          branch: "branch",
          path: "/worktree",
          error: null,
        })),
      },
    },
    workspaces: { list: jest.fn(async () => []), create: jest.fn(), remove: jest.fn() },
  }
  return client as unknown as FakeClient & Client
}
