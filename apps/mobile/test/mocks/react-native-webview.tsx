import { useEffect } from "react"
import { Pressable, Text } from "react-native"

/**
 * `react-native-webview` renders a native view that has no meaning in Jest.
 * Preview tests assert the source every mount actually loaded (`webviewMounts`,
 * which is what catches a stale URL after Stop -> Start) and drive the
 * load-failure paths through the trigger controls. The failing URL/code/status
 * is configurable per test so a failure can name a URL different from the live
 * one (the BFF nulls `url` when it flips the status to error).
 */
type WebViewErrorEvent = {
  nativeEvent: { code: number; description: string; url: string }
}

type WebViewHttpErrorEvent = {
  nativeEvent: { statusCode: number; description: string; url: string }
}

export type WebViewErrorTrigger = {
  url?: string
  code?: number
  description?: string
}

export type WebViewHttpErrorTrigger = {
  url?: string
  statusCode?: number
  description?: string
}

/** Every source URI mounted since the last reset, in mount order. */
export const webviewMounts: string[] = []

export function resetWebviewMounts(): void {
  webviewMounts.length = 0
}

let nextError: WebViewErrorTrigger | null = null
let nextHttpError: WebViewHttpErrorTrigger | null = null

/** One-shot override for the next `Trigger WebView error` press. */
export function setNextWebViewError(error: WebViewErrorTrigger | null): void {
  nextError = error
}

/** One-shot override for the next `Trigger WebView HTTP error` press. */
export function setNextWebViewHttpError(error: WebViewHttpErrorTrigger | null): void {
  nextHttpError = error
}

export function WebView({
  source,
  onError,
  onHttpError,
}: {
  source?: { uri?: string }
  onError?: (event: WebViewErrorEvent) => void
  onHttpError?: (event: WebViewHttpErrorEvent) => void
}) {
  const uri = source?.uri ?? ""
  // Function components re-run on every render; record only real mounts (the
  // modal's key change remounts the WebView, a plain re-render does not).
  useEffect(() => {
    webviewMounts.push(uri)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Text testID="preview-webview-source">{uri}</Text>
      {onError ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Trigger WebView error"
          onPress={() => {
            const override = nextError
            nextError = null
            onError({
              nativeEvent: {
                code: override?.code ?? -2,
                description: override?.description ?? "net::ERR_NAME_NOT_RESOLVED",
                url: override?.url ?? uri,
              },
            })
          }}
        >
          <Text>Trigger WebView error</Text>
        </Pressable>
      ) : null}
      {onHttpError ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Trigger WebView HTTP error"
          onPress={() => {
            const override = nextHttpError
            nextHttpError = null
            onHttpError({
              nativeEvent: {
                statusCode: override?.statusCode ?? 502,
                description: override?.description ?? "Bad gateway",
                url: override?.url ?? uri,
              },
            })
          }}
        >
          <Text>Trigger WebView HTTP error</Text>
        </Pressable>
      ) : null}
    </>
  )
}
