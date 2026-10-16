import { StyleSheet, Text, View } from "react-native"
import { SvgXml } from "react-native-svg"
import { providerIcon, providerMonogram } from "@masterhand/client-core"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * Compact provider brand mark for model triggers: the original vendored logo
 * when one exists (ADR-28), otherwise a deterministic monogram. Decorative —
 * the trigger keeps its own accessibility label with the full
 * "Provider · Model" name.
 */
export function ProviderGlyph({ providerID, name }: { providerID: string; name: string }) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const icon = providerIcon(providerID)
  if (icon) {
    return (
      <View style={styles.glyph} testID="model-provider-glyph" accessible={false}>
        <SvgXml xml={icon} width={12} height={12} color={colors.textMuted} />
      </View>
    )
  }
  return (
    <View style={styles.glyph} testID="model-provider-glyph" accessible={false}>
      <Text style={styles.monogram}>{providerMonogram(name)}</Text>
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    glyph: {
      alignItems: "center",
      justifyContent: "center",
    },
    monogram: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      fontWeight: "700",
    },
  })
}
