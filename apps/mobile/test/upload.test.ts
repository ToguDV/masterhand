import { nativeUpload } from "../src/upload"

// Production runs React Native's FormData polyfill, whose `{ uri, name, type }`
// file parts the native networking stack serializes — NOT the spec FormData
// that Jest's Node runtime provides. Use the real RN implementation so the
// test exercises the production contract.
const RNFormData = jest.requireActual("react-native/Libraries/Network/FormData").default as typeof FormData

type XhrListener = () => void

class MockXMLHttpRequest {
  static instances: MockXMLHttpRequest[] = []
  method: string | null = null
  url: string | null = null
  requestHeaders: Record<string, string> = {}
  requestBody: unknown = null
  status = 0
  responseText: string | null = null
  onload: XhrListener | null = null
  onerror: XhrListener | null = null
  ontimeout: XhrListener | null = null
  onabort: XhrListener | null = null

  constructor() {
    MockXMLHttpRequest.instances.push(this)
  }

  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }

  setRequestHeader(key: string, value: string): void {
    this.requestHeaders[key] = value
  }

  send(body: unknown): void {
    this.requestBody = body
  }

  respond(status: number, body: string): void {
    this.status = status
    this.responseText = body
    this.onload?.()
  }

  fail(): void {
    this.onerror?.()
  }
}

beforeEach(() => {
  MockXMLHttpRequest.instances = []
  globalThis.FormData = RNFormData
  globalThis.XMLHttpRequest = MockXMLHttpRequest as unknown as typeof XMLHttpRequest
  // The upload path must never touch any fetch: in production the global is
  // expo/fetch, whose convertFormDataAsync throws
  // "Unsupported FormDataPart implementation" for RN `{ uri }` file parts.
  globalThis.fetch = jest.fn(() => {
    throw new Error("nativeUpload must not use fetch")
  }) as unknown as typeof fetch
})

function parts(body: unknown): Array<Record<string, unknown>> {
  return (body as { getParts(): Array<Record<string, unknown>> }).getParts()
}

function lastXhr(): MockXMLHttpRequest {
  const xhr = MockXMLHttpRequest.instances[MockXMLHttpRequest.instances.length - 1]
  if (!xhr) throw new Error("expected nativeUpload to construct an XMLHttpRequest")
  return xhr
}

it("sends the picked file through React Native's XMLHttpRequest, not fetch", async () => {
  const pending = nativeUpload({
    url: "https://mh.example/api/workspaces/ws_1/attachments",
    headers: { authorization: "Bearer tok" },
    fileUri: "file:///data/user/0/host.exp.exponent/cache/DocumentPicker/photo.jpg",
    fieldName: "file",
    mimeType: "image/jpeg",
    parameters: { sessionID: "ses_1", attachmentID: "a1", name: "holiday photo.jpg" },
  })

  const xhr = lastXhr()
  expect(xhr.method).toBe("POST")
  expect(xhr.url).toBe("https://mh.example/api/workspaces/ws_1/attachments")
  expect(xhr.requestHeaders).toEqual({ authorization: "Bearer tok" })
  expect(parts(xhr.requestBody)).toEqual([
    expect.objectContaining({ string: "ses_1", fieldName: "sessionID" }),
    expect.objectContaining({ string: "a1", fieldName: "attachmentID" }),
    expect.objectContaining({ string: "holiday photo.jpg", fieldName: "name" }),
    expect.objectContaining({
      uri: "file:///data/user/0/host.exp.exponent/cache/DocumentPicker/photo.jpg",
      name: "holiday photo.jpg",
      type: "image/jpeg",
      fieldName: "file",
    }),
  ])
  expect(globalThis.fetch).not.toHaveBeenCalled()

  xhr.respond(201, '{"attachment":{"id":"a1"}}')
  await expect(pending).resolves.toEqual({ status: 201, body: '{"attachment":{"id":"a1"}}' })
})

it("passes a content:// URI through to the native networking stack", async () => {
  const pending = nativeUpload({
    url: "https://mh.example/api/workspaces/ws_1/attachments",
    headers: {},
    fileUri: "content://com.android.providers.downloads.documents/document/42",
    fieldName: "file",
    mimeType: "application/pdf",
    parameters: { sessionID: "ses_1", attachmentID: "a1", name: "report.pdf" },
  })

  const xhr = lastXhr()
  expect(parts(xhr.requestBody)[3]).toMatchObject({
    uri: "content://com.android.providers.downloads.documents/document/42",
    type: "application/pdf",
  })

  xhr.respond(413, '{"error":"attachment_too_large"}')
  await expect(pending).resolves.toEqual({ status: 413, body: '{"error":"attachment_too_large"}' })
})

it("rejects on transport failure instead of hanging", async () => {
  const pending = nativeUpload({
    url: "https://mh.example/api/workspaces/ws_1/attachments",
    headers: {},
    fileUri: "file:///data/user/0/host.exp.exponent/cache/DocumentPicker/photo.jpg",
    fieldName: "file",
    mimeType: "image/jpeg",
    parameters: { sessionID: "ses_1", attachmentID: "a1", name: "photo.jpg" },
  })
  lastXhr().fail()
  await expect(pending).rejects.toThrow("attachment upload failed")
})
