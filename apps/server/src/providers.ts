/**
 * Custom OpenAI-compatible providers.
 *
 * opencode has no HTTP API to register a provider: the definition only lives in
 * its config file. MasterHand owns a dedicated file loaded with `OPENCODE_CONFIG`
 * so it never has to parse or rewrite the user's own `opencode.json(c)`, and it
 * writes the credential separately through opencode's `connect/key` endpoint.
 *
 * The config shape is the one served by https://opencode.ai/config.json
 * (`provider.<id>` with `npm`, `options.baseURL` and `models`); opencode's
 * runtime exposes the same entry as `package`/`settings`.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/** AI SDK package that talks to the provider, keyed by the UI-facing name. */
export const CUSTOM_PROVIDER_PACKAGES = {
  "openai-compatible": "@opencode/ai/providers/openai-compatible",
  openai: "@opencode/ai/providers/openai",
} as const

export type CustomProviderPackage = keyof typeof CUSTOM_PROVIDER_PACKAGES

export interface CustomProviderModel {
  id: string
  name?: string
  /** Usable context window, in tokens (emitted only with `output`). */
  context?: number
  /** Maximum output tokens (emitted only with `context`). */
  output?: number
}

export interface CustomProvider {
  id: string
  name: string
  baseURL: string
  package: CustomProviderPackage
  models: CustomProviderModel[]
  headers?: Record<string, string>
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/
const MAX_ID = 64
const MAX_NAME = 64
const MAX_BASE_URL = 2048
/**
 * Models per provider. Shared by validation and discovery so a discovered list
 * can never exceed what the config accepts (a mismatch rejected valid lists).
 */
const MAX_MODELS = 200
const MAX_MODEL_ID = 128
const MAX_MODEL_NAME = 100
const MAX_HEADERS = 32
const MAX_HEADER_KEY = 64
const MAX_HEADER_VALUE = 1024
const MAX_LIMIT = 100_000_000
/** Deadline for the provider's `/models` call; the client deadline is longer. */
const MODELS_TIMEOUT_MS = 10_000

export type ValidationResult =
  | { ok: true; provider: CustomProvider }
  | { ok: false; error: string }

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function positiveLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_LIMIT) {
    return undefined
  }
  return Math.floor(value)
}

/** Strict header validation shared by provider writes and model discovery. */
function normalizeHeaders(raw: unknown): { ok: true; headers?: Record<string, string> } | { ok: false } {
  if (raw === undefined) return { ok: true }
  const record = asRecord(raw)
  if (!record) return { ok: false }
  const entries = Object.entries(record)
  if (entries.length > MAX_HEADERS) return { ok: false }
  const headers: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (!key || key.length > MAX_HEADER_KEY || /[\r\n]/.test(key)) return { ok: false }
    if (typeof value !== "string" || value.length > MAX_HEADER_VALUE || /[\r\n]/.test(value)) {
      return { ok: false }
    }
    headers[key] = value
  }
  return { ok: true, headers: entries.length > 0 ? headers : undefined }
}

/**
 * Validates and normalizes a create/update payload. Every field a provider
 * needs to work is required: without a model opencode shows nothing, and a
 * model without an id cannot be selected.
 */
export function validateCustomProvider(input: unknown): ValidationResult {
  const record = asRecord(input)
  if (!record) return { ok: false, error: "invalid_body" }

  const id = asString(record.id)?.trim() ?? ""
  if (!id || id.length > MAX_ID || !ID_PATTERN.test(id)) return { ok: false, error: "invalid_id" }

  const name = asString(record.name)?.trim() ?? ""
  if (!name || name.length > MAX_NAME) return { ok: false, error: "invalid_name" }

  const baseURL = asString(record.baseURL)?.trim() ?? ""
  if (!baseURL || baseURL.length > MAX_BASE_URL || !isHttpUrl(baseURL)) {
    return { ok: false, error: "invalid_base_url" }
  }

  const packageName = record.package === undefined ? "openai-compatible" : record.package
  if (packageName !== "openai-compatible" && packageName !== "openai") {
    return { ok: false, error: "invalid_package" }
  }

  const rawModels = Array.isArray(record.models) ? record.models : null
  if (!rawModels || rawModels.length === 0 || rawModels.length > MAX_MODELS) {
    return { ok: false, error: "invalid_models" }
  }
  const models: CustomProviderModel[] = []
  const seen = new Set<string>()
  for (const raw of rawModels) {
    const model = asRecord(raw)
    const modelID = asString(model?.id)?.trim() ?? ""
    if (!modelID || modelID.length > MAX_MODEL_ID || seen.has(modelID)) {
      return { ok: false, error: "invalid_models" }
    }
    seen.add(modelID)
    const modelName = asString(model?.name)?.trim() ?? ""
    if (modelName.length > MAX_MODEL_NAME) return { ok: false, error: "invalid_models" }
    const context = positiveLimit(model?.context)
    const output = positiveLimit(model?.output)
    models.push({
      id: modelID,
      ...(modelName ? { name: modelName } : {}),
      // Both bounds are required together by opencode's schema.
      ...(context !== undefined && output !== undefined ? { context, output } : {}),
    })
  }

  const headersResult = normalizeHeaders(record.headers)
  if (!headersResult.ok) return { ok: false, error: "invalid_headers" }
  const headers = headersResult.headers

  return {
    ok: true,
    provider: {
      id,
      name,
      baseURL,
      package: packageName,
      models,
      ...(headers ? { headers } : {}),
    },
  }
}

/** The `providers.<id>` entry opencode reads from the config file (v2 shape). */
function toOpencodeEntry(provider: CustomProvider): Record<string, unknown> {
  const models: Record<string, unknown> = {}
  for (const model of provider.models) {
    const limit =
      model.context !== undefined && model.output !== undefined
        ? { context: model.context, output: model.output }
        : undefined
    models[model.id] = {
      ...(model.name ? { name: model.name } : {}),
      ...(limit ? { limit } : {}),
    }
  }
  return {
    name: provider.name,
    package: CUSTOM_PROVIDER_PACKAGES[provider.package],
    settings: {
      baseURL: provider.baseURL,
      ...(provider.headers ? { headers: provider.headers } : {}),
    },
    models,
  }
}

function packageFromNpm(npm: string | null): CustomProviderPackage | null {
  if (npm === CUSTOM_PROVIDER_PACKAGES["openai-compatible"]) return "openai-compatible"
  if (npm === CUSTOM_PROVIDER_PACKAGES.openai) return "openai"
  return null
}

/** Tolerant reader: an entry MasterHand does not recognize is skipped, never guessed. */
function parseEntry(id: string, raw: unknown): CustomProvider | null {
  const record = asRecord(raw)
  if (!record) return null
  const providerPackage = packageFromNpm(asString(record.package))
  if (!providerPackage) return null
  const settings = asRecord(record.settings)
  const baseURL = asString(settings?.baseURL) ?? ""
  const name = asString(record.name) ?? id
  const headers: Record<string, string> = {}
  const rawHeaders = asRecord(settings?.headers)
  if (rawHeaders) {
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === "string") headers[key] = value
    }
  }
  const models: CustomProviderModel[] = []
  const rawModels = asRecord(record.models)
  if (rawModels) {
    for (const [modelID, rawModel] of Object.entries(rawModels)) {
      const model = asRecord(rawModel)
      const modelName = asString(model?.name)?.trim()
      const limit = asRecord(model?.limit)
      const context = positiveLimit(limit?.context)
      const output = positiveLimit(limit?.output)
      models.push({
        id: modelID,
        ...(modelName ? { name: modelName } : {}),
        ...(context !== undefined && output !== undefined ? { context, output } : {}),
      })
    }
  }
  return {
    id,
    name,
    baseURL,
    package: providerPackage,
    models,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  }
}

/** The custom-provider file exists but is not valid JSON; it is never overwritten. */
export class CustomProvidersFileError extends Error {
  constructor() {
    super("custom providers file is not valid JSON")
    this.name = "CustomProvidersFileError"
  }
}

/**
 * Web-search selection stored in the owned config file, mirroring opencode's
 * `websearch` key: `false` disables the tool, `"random"` picks an available
 * provider per query, and any other string is a provider id.
 */
export type WebsearchSelection = false | "random" | string

/** Keyless source written as the default so web search works without an API key. */
export const DEFAULT_WEBSEARCH_PROVIDER = "tinyfish"

export type WebsearchValidationResult =
  | { ok: true; value: WebsearchSelection }
  | { ok: false; error: "invalid_body" | "invalid_provider" }

/** Validates a `PUT /api/websearch` body (`{ provider }`). */
export function validateWebsearchSelection(input: unknown): WebsearchValidationResult {
  const record = asRecord(input)
  if (!record) return { ok: false, error: "invalid_body" }
  const provider = record.provider
  if (provider === false) return { ok: true, value: false }
  if (typeof provider !== "string") return { ok: false, error: "invalid_provider" }
  const trimmed = provider.trim()
  if (trimmed === "random") return { ok: true, value: "random" }
  if (!trimmed || trimmed.length > MAX_ID || !ID_PATTERN.test(trimmed)) {
    return { ok: false, error: "invalid_provider" }
  }
  return { ok: true, value: trimmed }
}

/** Tolerant read of the raw `websearch` value; unrecognized shapes read as none. */
function selectionFromValue(value: unknown): WebsearchSelection | null {
  if (value === false) return false
  const record = asRecord(value)
  if (!record) return null
  const provider = record.provider
  if (typeof provider !== "string") return null
  const trimmed = provider.trim()
  if (!trimmed || trimmed.length > MAX_ID) return null
  return trimmed
}

export interface CustomProviderStore {
  list(): Promise<CustomProvider[]>
  /** Idempotent upsert by id. */
  upsert(provider: CustomProvider): Promise<CustomProvider>
  /** Idempotent: removing an unknown id is a no-op. */
  remove(id: string): Promise<void>
  /** Current web-search selection, or null when absent/unrecognized. */
  getWebsearch(): Promise<WebsearchSelection | null>
  /** True when the `websearch` key is present with any value (hand-edited ones included). */
  hasWebsearch(): Promise<boolean>
  /** Writes the selection; `null` removes the key so opencode keeps its own state. */
  setWebsearch(selection: WebsearchSelection | null): Promise<void>
}

interface Document {
  providers: Record<string, unknown>
  /** Every other top-level key of the owned file, preserved verbatim on write. */
  rest: Record<string, unknown>
}

/**
 * Writes the keyless default selection when the owned file has none, so agent
 * web searches work out of the box (opencode's own provider prompt is not
 * rendered by MasterHand clients). Never overrides a present value — a
 * hand-edited one included — and a corrupt file stays untouched (it throws,
 * and the caller logs and moves on).
 */
export async function ensureWebsearchDefault(
  store: Pick<CustomProviderStore, "hasWebsearch" | "setWebsearch">,
  provider: string = DEFAULT_WEBSEARCH_PROVIDER,
): Promise<boolean> {
  if (await store.hasWebsearch()) return false
  await store.setWebsearch(provider)
  return true
}

/**
 * File-backed store: one atomic write (temp file + rename) per mutation, and
 * every read-modify-write serialized so two devices cannot interleave. Reads
 * preserve unknown `provider` entries so a hand-added provider is never lost.
 */
export function createCustomProviderStore(options: { file: string }): CustomProviderStore {
  const { file } = options
  let queue: Promise<unknown> = Promise.resolve()

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function readDocument(): Promise<Document> {
    let text: string
    try {
      text = await readFile(file, "utf8")
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "ENOENT") return { providers: {}, rest: {} }
      throw error
    }
    if (!text.trim()) return { providers: {}, rest: {} }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new CustomProvidersFileError()
    }
    const root = asRecord(parsed)
    if (!root) return { providers: {}, rest: {} }
    const { providers, ...rest } = root
    return { providers: asRecord(providers) ?? {}, rest }
  }

  async function writeDocument(document: Document): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    // Every top-level key the file carried (a hand-added `websearch`, another
    // tool's section, …) is written back untouched: this file is shared.
    const payload = {
      $schema: "https://opencode.ai/config.json",
      ...document.rest,
      providers: document.providers,
    }
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
    await rename(temp, file)
  }

  return {
    list: () =>
      serialize(async () => {
        const document = await readDocument()
        const providers: CustomProvider[] = []
        for (const [id, raw] of Object.entries(document.providers)) {
          const provider = parseEntry(id, raw)
          if (provider) providers.push(provider)
        }
        return providers
      }),
    upsert: (provider) =>
      serialize(async () => {
        const document = await readDocument()
        document.providers[provider.id] = toOpencodeEntry(provider)
        await writeDocument(document)
        return provider
      }),
    remove: (id) =>
      serialize(async () => {
        const document = await readDocument()
        if (!(id in document.providers)) return
        delete document.providers[id]
        await writeDocument(document)
      }),
    getWebsearch: () => serialize(async () => selectionFromValue((await readDocument()).rest.websearch)),
    hasWebsearch: () =>
      serialize(async () => Object.prototype.hasOwnProperty.call((await readDocument()).rest, "websearch")),
    setWebsearch: (selection) =>
      serialize(async () => {
        const document = await readDocument()
        if (selection === null) delete document.rest.websearch
        else document.rest.websearch = selection === false ? false : { provider: selection }
        await writeDocument(document)
      }),
  }
}

export interface DiscoverModelsInput {
  baseURL: string
  key?: string
  headers?: Record<string, string>
}

export type DiscoverModelsResult =
  | { ok: true; models: CustomProviderModel[] }
  | { ok: false; error: DiscoverModelsError }

export type DiscoverModelsError =
  | "invalid_body"
  | "invalid_base_url"
  | "invalid_headers"
  | "invalid_key"
  | "provider_timeout"
  | "provider_unreachable"
  | "provider_unauthorized"
  | "provider_failed"
  | "provider_invalid_response"
  | "provider_no_models"

/**
 * Validates a model-discovery body. The provider does not exist yet, so only
 * the fields needed for the `/models` request are required: a base URL, an
 * optional key and optional headers.
 */
export function validateDiscoverInput(
  input: unknown,
): { ok: true; value: DiscoverModelsInput } | { ok: false; error: DiscoverModelsError } {
  const record = asRecord(input)
  if (!record) return { ok: false, error: "invalid_body" }

  const baseURL = asString(record.baseURL)?.trim() ?? ""
  if (!baseURL || baseURL.length > MAX_BASE_URL || !isHttpUrl(baseURL)) {
    return { ok: false, error: "invalid_base_url" }
  }
  const headersResult = normalizeHeaders(record.headers)
  if (!headersResult.ok) return { ok: false, error: "invalid_headers" }
  const key = asString(record.key)?.trim() ?? ""
  if (key.length > MAX_HEADER_VALUE) return { ok: false, error: "invalid_key" }

  return {
    ok: true,
    value: {
      baseURL,
      ...(key ? { key } : {}),
      ...(headersResult.headers ? { headers: headersResult.headers } : {}),
    },
  }
}

/**
 * Reads an OpenAI-style `/models` payload. Accepts `{ data: [...] }` (the
 * standard), `{ models: [...] }` and a bare array, and tolerates entries with
 * `name` or `display_name`. Invalid/duplicate ids are skipped, never guessed.
 */
export function parseModelsResponse(raw: unknown): CustomProviderModel[] {
  const record = asRecord(raw)
  const list = Array.isArray(raw)
    ? raw
    : record && Array.isArray(record.data)
      ? record.data
      : record && Array.isArray(record.models)
        ? record.models
        : null
  if (!list) return []

  const models: CustomProviderModel[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const entry = asRecord(item)
    const id = asString(entry?.id)?.trim() ?? ""
    if (!id || id.length > MAX_MODEL_ID || seen.has(id)) continue
    seen.add(id)
    const name = (asString(entry?.name) ?? asString(entry?.display_name))?.trim() ?? ""
    models.push({ id, ...(name && name.length <= MAX_MODEL_NAME ? { name } : {}) })
    if (models.length >= MAX_MODELS) break
  }
  return models
}

/**
 * Calls the provider's `/models` endpoint with the transient key. The request
 * is bounded (`MODELS_TIMEOUT_MS`) and injectable for tests; the key is never
 * logged or persisted here.
 */
export async function fetchProviderModels(
  input: DiscoverModelsInput,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DiscoverModelsResult> {
  const doFetch = options.fetchImpl ?? fetch
  const target = `${input.baseURL.replace(/\/+$/, "")}/models`
  const headers: Record<string, string> = {
    accept: "application/json",
    ...input.headers,
    ...(input.key ? { authorization: `Bearer ${input.key}` } : {}),
  }

  let response: Response
  try {
    response = await doFetch(target, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? MODELS_TIMEOUT_MS),
    })
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "TimeoutError") {
      return { ok: false, error: "provider_timeout" }
    }
    return { ok: false, error: "provider_unreachable" }
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: "provider_unauthorized" }
  }
  if (!response.ok) return { ok: false, error: "provider_failed" }

  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    return { ok: false, error: "provider_invalid_response" }
  }
  const models = parseModelsResponse(raw)
  if (models.length === 0) return { ok: false, error: "provider_no_models" }
  return { ok: true, models }
}
