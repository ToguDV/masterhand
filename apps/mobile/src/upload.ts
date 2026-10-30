import type { NativeUploadInput, NativeUploadResult } from "@masterhand/client-core"

/**
 * Multipart attachment upload through React Native's **global** `fetch`.
 *
 * The app streams API/SSE traffic through `expo/fetch`, which stringifies
 * React Native's `{ uri, name, type }` FormData file part instead of sending
 * the file, so uploads must not use `ClientOptions.fetchImpl`.
 *
 * Global fetch is React Native's own XHR implementation: it builds a real
 * multipart body and reads the file through the native networking stack.
 *
 * Do not replace this with `expo-file-system`'s `uploadAsync`: in Expo Go its
 * permission service only allows paths inside the experience-scoped
 * directories (`ScopedFilePermissionService`), while `expo-document-picker`
 * copies into Expo Go's shared cache (`.../cache/DocumentPicker/...`). That
 * path is rejected with "Location 'file:///...' isn't readable" before any
 * byte leaves the device.
 */
export async function nativeUpload(input: NativeUploadInput): Promise<NativeUploadResult> {
  const form = new FormData()
  for (const [key, value] of Object.entries(input.parameters)) form.append(key, value)
  form.append(input.fieldName, {
    uri: input.fileUri,
    name: input.parameters.name || "file",
    type: input.mimeType,
  } as unknown as Blob)

  const response = await fetch(input.url, {
    method: "POST",
    headers: input.headers,
    body: form,
  })
  return { status: response.status, body: await response.text() }
}
