import { nativeUpload } from "../src/upload"

// Jest's Node runtime provides undici's spec FormData; production runs React
// Native's polyfill, whose `{ uri, name, type }` file parts the native XHR
// serializes. Use the real RN implementation so the test pins that contract.
const RNFormData = jest.requireActual("react-native/Libraries/Network/FormData").default as typeof FormData
const fetchMock = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  globalThis.FormData = RNFormData
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterAll(() => {
  fetchMock.mockReset()
})

function parts(body: unknown): Array<Record<string, unknown>> {
  return (body as { getParts(): Array<Record<string, unknown>> }).getParts()
}

it("sends the picked file through React Native's global fetch", async () => {
  fetchMock.mockResolvedValue({
    status: 201,
    text: async () => '{"attachment":{"id":"a1"}}',
  })

  const result = await nativeUpload({
    url: "https://mh.example/api/workspaces/ws_1/attachments",
    headers: { authorization: "Bearer tok" },
    fileUri: "file:///data/user/0/host.exp.exponent/cache/DocumentPicker/photo.jpg",
    fieldName: "file",
    mimeType: "image/jpeg",
    parameters: { sessionID: "ses_1", attachmentID: "a1", name: "holiday photo.jpg" },
  })

  expect(result).toEqual({ status: 201, body: '{"attachment":{"id":"a1"}}' })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  expect(url).toBe("https://mh.example/api/workspaces/ws_1/attachments")
  expect(init).toMatchObject({
    method: "POST",
    headers: { authorization: "Bearer tok" },
  })

  const bodyParts = parts(init.body)
  expect(bodyParts).toEqual([
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
})

it("passes a content:// URI through to the native networking stack", async () => {
  fetchMock.mockResolvedValue({ status: 413, text: async () => '{"error":"attachment_too_large"}' })

  const result = await nativeUpload({
    url: "https://mh.example/api/workspaces/ws_1/attachments",
    headers: {},
    fileUri: "content://com.android.providers.downloads.documents/document/42",
    fieldName: "file",
    mimeType: "application/pdf",
    parameters: { sessionID: "ses_1", attachmentID: "a1", name: "report.pdf" },
  })

  expect(result).toEqual({ status: 413, body: '{"error":"attachment_too_large"}' })
  expect(parts((fetchMock.mock.calls[0][1] as RequestInit).body)[3]).toMatchObject({
    uri: "content://com.android.providers.downloads.documents/document/42",
    type: "application/pdf",
  })
})
