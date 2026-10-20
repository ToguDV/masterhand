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

import { lookup } from "node:dns/promises"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { isIP } from "node:net"
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

/**
 * Resolves a hostname to every address the request could reach. Injectable so
 * tests never depend on real DNS; the default uses the system resolver.
 */
export type HostResolver = (hostname: string) => Promise<readonly string[]>

async function lookupHostAddresses(hostname: string): Promise<readonly string[]> {
  const entries = await lookup(hostname, { all: true, verbatim: true })
  return entries.map((entry) => entry.address)
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
 * Target guard for model discovery: it forwards a caller-supplied key/headers,
 * so the target must not be able to reach this host or a cloud metadata
 * service. Private LAN ranges stay allowed (ADR-30): self-hosted providers
 * commonly live there. The ranges mirror the IANA special-purpose registry:
 * loopback, "this network"/unspecified, link-local (cloud IMDS included),
 * multicast and reserved/broadcast. IPv4-mapped IPv6 is unwrapped first.
 */

/** Strict dotted-quad parser; the URL parser already normalizes odd forms. */
function parseIPv4(address: string): number | null {
  const parts = address.split(".")
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value >>> 0
}

function parseIPv6(raw: string): number[] | null {
  let address = raw.trim().toLowerCase()
  const zone = address.indexOf("%")
  if (zone !== -1) address = address.slice(0, zone)
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1)
  if (!address.includes(":")) return null
  if (address.includes(".")) {
    // Trailing dotted quad (::ffff:127.0.0.1) becomes two hex groups.
    const lastColon = address.lastIndexOf(":")
    const embedded = parseIPv4(address.slice(lastColon + 1))
    if (embedded === null) return null
    address = `${address.slice(0, lastColon + 1)}${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`
  }
  const halves = address.split("::")
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (!part) return []
    const groups: number[] = []
    for (const item of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null
      groups.push(Number.parseInt(item, 16))
    }
    return groups
  }
  const head = parse(halves[0] ?? "")
  const tail = parse(halves[1] ?? "")
  if (!head || !tail) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const fill = 8 - head.length - tail.length
  if (fill < 1) return null
  return [...head, ...Array<number>(fill).fill(0), ...tail]
}

function isBlockedIPv4(value: number): boolean {
  const first = value >>> 24
  if (first === 0) return true // 0.0.0.0/8: unspecified and "this network"
  if (first === 127) return true // loopback
  if (value >>> 16 === 0xa9fe) return true // 169.254.0.0/16: link-local, cloud IMDS
  if (first >= 224) return true // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
  return false
}

function isBlockedIPv6(groups: readonly number[]): boolean {
  const g = groups
  const embedded = ((g[6]! << 16) | g[7]!) >>> 0
  // :: and ::1
  if (g.slice(0, 7).every((group) => group === 0) && (g[7] === 0 || g[7] === 1)) return true
  // ::ffff:a.b.c.d/96 (IPv4-mapped) and the deprecated ::a.b.c.d/96 form.
  if (g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff) return isBlockedIPv4(embedded)
  if (g.slice(0, 6).every((group) => group === 0)) return isBlockedIPv4(embedded)
  if ((g[0]! & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g[0]! & 0xff00) === 0xff00) return true // ff00::/8 multicast
  // AWS IPv6 IMDS sits inside the otherwise-private ULA space.
  if (
    g[0] === 0xfd00 &&
    g[1] === 0x0ec2 &&
    g.slice(2, 7).every((group) => group === 0) &&
    g[7] === 0x0254
  ) {
    return true
  }
  return false
}

/** Loopback only: allows an explicit opt-in without opening metadata targets. */
function isLoopbackAddress(address: string): boolean {
  const zone = address.indexOf("%")
  const bare = (zone === -1 ? address : address.slice(0, zone)).trim()
  const family = isIP(bare)
  if (family === 4) return parseIPv4(bare)! >>> 24 === 127
  if (family !== 6) return false
  const groups = parseIPv6(bare)
  if (!groups) return false
  const embedded = ((groups[6]! << 16) | groups[7]!) >>> 0
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return embedded >>> 24 === 127
  }
  if (groups.slice(0, 6).every((group) => group === 0)) return embedded >>> 24 === 127
  return false
}

/** Fails closed: an address shape this file cannot parse is never fetched. */
function isBlockedTargetAddress(address: string): boolean {
  const zone = address.indexOf("%")
  const bare = (zone === -1 ? address : address.slice(0, zone)).trim()
  const family = isIP(bare)
  if (family === 4) {
    const value = parseIPv4(bare)
    return value === null || isBlockedIPv4(value)
  }
  if (family === 6) {
    const groups = parseIPv6(bare)
    return groups === null || isBlockedIPv6(groups)
  }
  return true
}

/** URL hostnames keep the IPv6 brackets and percent-encode the zone id. */
function hostLiteral(hostname: string): string {
  let value = hostname
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1)
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const TARGET_LOOKUP_TIMEOUT = Symbol("target_lookup_timeout")

/**
 * Resolves every address a hostname points at, bounded by the caller's
 * deadline. A resolution error yields `[]`: the name cannot reach anything,
 * so the request is attempted and its own error mapping applies.
 */
async function resolveTargetAddresses(
  resolver: HostResolver,
  hostname: string,
  timeoutMs: number,
): Promise<readonly string[] | typeof TARGET_LOOKUP_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TARGET_LOOKUP_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TARGET_LOOKUP_TIMEOUT), timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()
  })
  const addresses = resolver(hostname).then(
    (resolved) => resolved,
    () => [] as readonly string[],
  )
  try {
    return await Promise.race([addresses, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** `null` when the target may be called; otherwise the typed discovery error. */
async function inspectDiscoverTarget(
  url: URL,
  resolver: HostResolver,
  timeoutMs: number,
  allowLoopback: boolean,
): Promise<"invalid_base_url" | "provider_timeout" | null> {
  const hostname = hostLiteral(url.hostname)
  const zone = hostname.indexOf("%")
  const bare = zone === -1 ? hostname : hostname.slice(0, zone)
  if (isIP(bare) !== 0) {
    if (!isBlockedTargetAddress(bare)) return null
    return allowLoopback && isLoopbackAddress(bare) ? null : "invalid_base_url"
  }
  const addresses = await resolveTargetAddresses(resolver, hostname, timeoutMs)
  if (addresses === TARGET_LOOKUP_TIMEOUT) return "provider_timeout"
  const blocked = addresses.filter((address) => isBlockedTargetAddress(address))
  if (blocked.length === 0) return null
  // The opt-in covers loopback only; a name resolving to both loopback and a
  // link-local/metadata address stays blocked.
  return allowLoopback && blocked.every((address) => isLoopbackAddress(address)) ? null : "invalid_base_url"
}

/**
 * Calls the provider's `/models` endpoint with the transient key. The request
 * is bounded (`MODELS_TIMEOUT_MS`) and injectable for tests; the key is never
 * logged or persisted here. The target is checked before any request: loopback,
 * link-local/metadata, unspecified, multicast and reserved addresses are
 * refused, including hostnames that resolve to them. Private LAN stays allowed.
 */
export async function fetchProviderModels(
  input: DiscoverModelsInput,
  options: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    resolver?: HostResolver
    /** Explicit opt-in for local providers (native installs, tests). */
    allowLoopback?: boolean
  } = {},
): Promise<DiscoverModelsResult> {
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? MODELS_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const target = `${input.baseURL.replace(/\/+$/, "")}/models`
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return { ok: false, error: "invalid_base_url" }
  }
  const targetError = await inspectDiscoverTarget(
    url,
    options.resolver ?? lookupHostAddresses,
    timeoutMs,
    options.allowLoopback === true,
  )
  if (targetError) return { ok: false, error: targetError }

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
      // One budget covers the target lookup and the request itself.
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
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
