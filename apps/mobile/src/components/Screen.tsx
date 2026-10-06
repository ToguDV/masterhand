import { useEffect, useState, type PropsWithChildren } from "react"
import { Keyboard, KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { useThemedStyles, type Palette } from "../theme"

/** Tracks whether the soft keyboard is up, so the bottom inset can be dropped while it covers that area. */
function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () =>
      setVisible(true),
    )
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () =>
      setVisible(false),
    )
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])

  return visible
}

/**
 * Screen shell: keeps content clear of the system bars and of the keyboard.
 *
 * The `KeyboardAvoidingView` is required on Android since edge-to-edge became
 * mandatory (Expo SDK 54, RN 0.86): the window no longer resizes for the IME,
 * so a bottom-pinned input (the composer) would end up behind it. `padding`
 * shrinks the content by the real overlap, which is also right on iOS.
 *
 * The bottom safe-area inset is dropped while the keyboard is up: the keyboard
 * already occupies that strip, so keeping the inset would leave the input
 * floating a navigation bar's height too high.
 */
export function Screen({ children, style }: PropsWithChildren<{ style?: object }>) {
  const keyboardVisible = useKeyboardVisible()
  const styles = useThemedStyles(createStyles)

  return (
    <KeyboardAvoidingView style={styles.root} behavior="padding">
      <SafeAreaView
        style={styles.root}
        edges={keyboardVisible ? ["top", "left", "right"] : ["top", "right", "bottom", "left"]}
      >
        <View style={[styles.content, style]}>{children}</View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  )
}

function createStyles(colors: Palette) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.canvas,
    },
    content: {
      flex: 1,
    },
  })
}
