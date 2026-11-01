import { Pressable, Text } from "react-native"

/**
 * `react-native-webview` renders a native view that has no meaning in Jest; the
 * preview tests assert that the modal mounts a WebView with the tunnel URL and
 * can drive the load-failure path through the `Trigger WebView error` control.
 */
type WebViewErrorEvent = {
  nativeEvent: { code?: number; description?: string; url?: string }
}

type WebViewHttpErrorEvent = {
  nativeEvent: { statusCode?: number; description?: string }
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
  return (
    <>
      <Text>{`WebView: ${source?.uri ?? ""}`}</Text>
      {onError ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Trigger WebView error"
          onPress={() =>
            onError({
              nativeEvent: {
                code: -2,
                description: "net::ERR_NAME_NOT_RESOLVED",
                url: source?.uri,
              },
            })
          }
        >
          <Text>Trigger WebView error</Text>
        </Pressable>
      ) : null}
      {onHttpError ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Trigger WebView HTTP error"
          onPress={() => onHttpError({ nativeEvent: { statusCode: 502, description: "Bad gateway" } })}
        >
          <Text>Trigger WebView HTTP error</Text>
        </Pressable>
      ) : null}
    </>
  )
}
