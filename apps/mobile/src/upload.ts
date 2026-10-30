import type { NativeUploadInput, NativeUploadResult } from "@masterhand/client-core"

/**
 * Multipart attachment upload through React Native's `XMLHttpRequest`.
 *
 * The app streams API/SSE traffic through `expo/fetch`, which replaces the
 * global `fetch` (see `expo/src/winter/runtime.native.ts`: `install('fetch',
 * ...)`). Its `convertFormDataAsync` only accepts strings, Blobs, or
 * `{ bytes }` entries, so React Native's `{ uri, name, type }` file part is
 * rejected with "Unsupported FormDataPart implementation" before any byte
 * leaves the device. `XMLHttpRequest` is *not* patched by expo: `send()`
 * hands the RN `FormData` to `RCTNetworking.sendRequest`, whose native file
 * handlers read `file://` and `content://` URIs directly.
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

  return new Promise<NativeUploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", input.url)
    for (const [key, value] of Object.entries(input.headers)) xhr.setRequestHeader(key, value)
    // `onload` fires for every HTTP status (including 4xx/5xx): resolve with
    // the status so client-core maps failures to `ApiError` itself. Only a
    // transport-level failure rejects.
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText ?? "" })
    xhr.onerror = () => reject(new Error("attachment upload failed"))
    xhr.ontimeout = () => reject(new Error("attachment upload timed out"))
    xhr.onabort = () => reject(new Error("attachment upload aborted"))
    xhr.send(form as unknown as BodyInit)
  })
}
