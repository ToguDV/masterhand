jest.mock("expo-file-system/legacy", () => ({
  uploadAsync: jest.fn(),
  FileSystemUploadType: { MULTIPART: 1 },
  FileSystemSessionType: { FOREGROUND: 1 },
}))

import * as FileSystem from "expo-file-system/legacy"
import { nativeUpload } from "../src/upload"

const uploadAsync = FileSystem.uploadAsync as unknown as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
})

it("sends the picked file through the native multipart uploader", async () => {
  uploadAsync.mockResolvedValue({ status: 201, body: '{"attachment":{"id":"a1"}}' })

  const result = await nativeUpload({
    url: "https://mh.example/api/workspaces/ws_1/attachments",
    headers: { authorization: "Bearer tok" },
    fileUri: "file:///tmp/photo.jpg",
    fieldName: "file",
    mimeType: "image/jpeg",
    parameters: { sessionID: "ses_1", attachmentID: "a1" },
  })

  expect(result).toEqual({ status: 201, body: '{"attachment":{"id":"a1"}}' })
  expect(uploadAsync).toHaveBeenCalledWith(
    "https://mh.example/api/workspaces/ws_1/attachments",
    "file:///tmp/photo.jpg",
    expect.objectContaining({
      httpMethod: "POST",
      uploadType: 1,
      fieldName: "file",
      mimeType: "image/jpeg",
      parameters: { sessionID: "ses_1", attachmentID: "a1" },
      headers: { authorization: "Bearer tok" },
      sessionType: 1,
    }),
  )
})
