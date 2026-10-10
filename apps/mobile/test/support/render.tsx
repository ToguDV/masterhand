import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Client, GoalRun, PreviewStatus, RunStatus } from "@masterhand/client-core"

export const STOPPED_RUN: RunStatus = {
  status: "stopped",
  command: null,
  args: [],
  port: null,
  pid: null,
  error: null,
}

export const STOPPED_PREVIEW: PreviewStatus = { status: "stopped", url: null, port: null, error: null }

/** A running goal run for tests that only need "some run" (e.g. fake defaults). */
export const RUNNING_GOAL: GoalRun = {
  sessionID: "s1",
  goal: "Ship the feature",
  state: "running",
  round: 1,
  maxRounds: 5,
  mainModel: null,
  criticModel: null,
  judgeModel: null,
  lastReport: null,
  lastCritique: null,
  lastVerdict: null,
  criticSessionID: null,
  judgeSessionID: null,
  history: [],
  error: null,
  awaitingKind: null,
  attempt: 0,
  lastError: null,
  pausedPhase: null,
  createdAt: 0,
  updatedAt: 0,
}

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
    integrations: jest.Mock
    connectIntegrationKey: jest.Mock
    credentials: jest.Mock
    removeCredential: jest.Mock
    activateCredential: jest.Mock
    customProviders: jest.Mock
    createCustomProvider: jest.Mock
    removeCustomProvider: jest.Mock
    listCustomProviderModels: jest.Mock
    websearchSources: jest.Mock
    websearchSettings: jest.Mock
    saveWebsearchSettings: jest.Mock
    testWebsearch: jest.Mock
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
    run: jest.Mock
    saveRun: jest.Mock
    detectRun: jest.Mock
    sessionRun: jest.Mock
    startSessionRun: jest.Mock
    stopSessionRun: jest.Mock
    goal: {
      start: jest.Mock
      status: jest.Mock
      pause: jest.Mock
      resume: jest.Mock
      cancel: jest.Mock
      settings: jest.Mock
      saveSettings: jest.Mock
    }
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
      integrations: jest.fn(async () => []),
      connectIntegrationKey: jest.fn(async () => {}),
      credentials: jest.fn(async () => []),
      removeCredential: jest.fn(async () => {}),
      activateCredential: jest.fn(async () => {}),
      customProviders: jest.fn(async () => []),
      createCustomProvider: jest.fn(async () => ({
        provider: {
          id: "custom",
          name: "Custom",
          baseURL: "https://x.example/v1",
          package: "openai-compatible" as const,
          models: [{ id: "m" }],
        },
        connected: false,
      })),
      removeCustomProvider: jest.fn(async () => {}),
      listCustomProviderModels: jest.fn(async () => []),
      websearchSources: jest.fn(async () => []),
      websearchSettings: jest.fn(async () => null),
      saveWebsearchSettings: jest.fn(async (provider: string | "random" | false) => provider),
      testWebsearch: jest.fn(async () => ({ providerID: "tinyfish", results: [] })),
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
      run: jest.fn(async () => null),
      saveRun: jest.fn(async () => ({
        command: "npm",
        args: ["run", "dev"],
        cwd: null,
        source: "user" as const,
        updatedAt: 1,
      })),
      detectRun: jest.fn(async () => ({ command: "pnpm", args: ["dev"], cwd: null })),
      sessionRun: jest.fn(async () => STOPPED_RUN),
      startSessionRun: jest.fn(async () => STOPPED_RUN),
      stopSessionRun: jest.fn(async () => {}),
      goal: {
        start: jest.fn(async () => RUNNING_GOAL),
        status: jest.fn(async () => null),
        pause: jest.fn(async () => RUNNING_GOAL),
        resume: jest.fn(async () => RUNNING_GOAL),
        cancel: jest.fn(async () => RUNNING_GOAL),
        settings: jest.fn(async () => ({ maxRounds: 5, criticModel: null, judgeModel: null })),
        saveSettings: jest.fn(
          async (patch: { maxRounds?: number; criticModel?: string | null; judgeModel?: string | null }) => ({
            maxRounds: patch.maxRounds ?? 5,
            criticModel: patch.criticModel ?? null,
            judgeModel: patch.judgeModel ?? null,
          }),
        ),
      },
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
