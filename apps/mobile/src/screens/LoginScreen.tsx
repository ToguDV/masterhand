import { useState } from "react"
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { Screen } from "../components/Screen"
import { Deco } from "../components/Deco"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

export function LoginScreen({
  initialServerUrl,
  busy,
  error,
  onSubmit,
}: {
  initialServerUrl: string | null
  busy: boolean
  error: string | null
  onSubmit: (serverUrl: string, password: string) => void
}) {
  const [serverUrl, setServerUrl] = useState(initialServerUrl ?? "")
  const [password, setPassword] = useState("")
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)

  const canSubmit = serverUrl.trim().length > 0 && password.length > 0 && !busy

  return (
    <Screen style={styles.screen}>
      <View style={styles.decoWrap} pointerEvents="none">
        <Deco variant="blob" style={styles.blob} />
        <Deco variant="dots" style={styles.dots} />
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>MasterHand</Text>
        <Text style={styles.subtitle}>Your opencode agents, from anywhere.</Text>

        <Text style={styles.label}>Server URL</Text>
        <TextInput
          style={styles.input}
          testID="server-url-input"
          value={serverUrl}
          onChangeText={setServerUrl}
          placeholder="https://masterhand.example.com"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          inputMode="url"
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          testID="password-input"
          value={password}
          onChangeText={setPassword}
          placeholder="••••••••"
          placeholderTextColor={colors.textFaint}
          secureTextEntry
          autoCapitalize="none"
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={[styles.button, !canSubmit && styles.buttonDisabled]}
          disabled={!canSubmit}
          onPress={() => onSubmit(serverUrl.trim(), password)}
        >
          {busy ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <Text style={[styles.buttonText, !canSubmit && styles.buttonTextDisabled]}>Sign in</Text>
          )}
        </Pressable>
      </View>
    </Screen>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    screen: {
      justifyContent: "center",
      paddingHorizontal: 16,
    },
    decoWrap: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      overflow: "hidden",
    },
    blob: {
      position: "absolute",
      top: -60,
      right: -70,
    },
    dots: {
      position: "absolute",
      bottom: 24,
      left: -16,
      opacity: 0.55,
    },
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.surface,
      borderRadius: 24,
      padding: 20,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 26,
      fontWeight: "500",
      lineHeight: 31,
    },
    subtitle: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 14,
      marginTop: 4,
    },
    label: {
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "500",
      marginTop: 16,
      marginBottom: 6,
    },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
      minHeight: 44,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    error: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 13,
      marginTop: 10,
    },
    button: {
      marginTop: 18,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      borderRadius: 12,
      backgroundColor: colors.accent,
    },
    buttonDisabled: {
      backgroundColor: colors.surfaceMuted,
    },
    buttonText: {
      color: colors.onAccent,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    buttonTextDisabled: {
      color: colors.textFaint,
    },
  })
}
