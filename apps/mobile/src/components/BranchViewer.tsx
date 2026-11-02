import { StyleSheet, Text, View } from "react-native"
import { useBranches, type Client } from "@masterhand/client-core"
import { BranchIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * Read-only branch view: shows the workspace's current branch and refreshes
 * every few seconds so a branch the agent switches externally is reflected.
 * It is not pressable and never opens a picker.
 */
export function BranchViewer({ client, workspaceID }: { client: Client; workspaceID: string }) {
  const info = useBranches(client, true, workspaceID, 5_000).data
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  if (!info?.current) return null
  return (
    <View style={styles.chip} accessibilityLabel={`Current branch ${info.current}`}>
      <BranchIcon size={14} color={colors.textMuted} />
      <Text style={styles.chipText} numberOfLines={1}>
        {info.current}
      </Text>
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      flexShrink: 1,
      maxWidth: 224,
      minHeight: 34,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 10,
    },
    chipText: {
      flexShrink: 1,
      color: colors.textSoft,
      fontFamily: fonts.mono,
      fontSize: 12,
      lineHeight: 16,
    },
  })
}
