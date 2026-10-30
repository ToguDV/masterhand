import * as FileSystem from "expo-file-system/legacy"
import type { NativeUploadInput, NativeUploadResult } from "@masterhand/client-core"

/**
 * Native multipart upload. The app's `expo/fetch` cannot serialize React
 * Native's `{ uri, name, type }` file object, so attachments go through the
 * file-system bridge, which reads the picked `file://`/`content://` URI with
 * the native networking stack.
 */
export async function nativeUpload(input: NativeUploadInput): Promise<NativeUploadResult> {
  // Android's picker can hand back `file:////data/...` (an extra leading
  // slash); expo-file-system then resolves the path as `//data/...` and the
  // permission service rejects it as unreadable. Normalize to one `file:///`.
  const fileUri = input.fileUri.replace(/^file:\/\/*/, "file:///")
  const result = await FileSystem.uploadAsync(input.url, fileUri, {
    httpMethod: "POST",
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: input.fieldName,
    mimeType: input.mimeType,
    parameters: input.parameters,
    headers: input.headers,
    // Foreground keeps the promise alive while the composer owns the send.
    sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
  })
  return { status: result.status, body: result.body }
}
