import { Pressable, StyleSheet, Text, View } from "react-native"
import { useInterruptedTurns, useResumeTurn, type Client } from "@masterhand/client-core"
import { useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * A turn that died with the engine/BFF. The manual action sends the same
 * marker-reconciled continuation as the automatic recovery pass; the agent is
 * told to verify the current state and avoid re-running heavy work unchanged.
 */
export function InterruptedTurnCard({ client, sessionID }: { client: Client; sessionID: string }) {
  const turns = useInterruptedTurns(client)
  const resume = useResumeTurn(client)
  const styles = useThemedStyles(createStyles)
  const turn = turns.data?.find((entry) => entry.sessionID === sessionID)
  if (!turn) return null
  const ambiguous = turn.state === "ambiguous"
  return (
    <View style={styles.wrap} accessibilityRole="alert">
      <Text style={styles.text}>
        {ambiguous
          ? "This turn was interrupted by a restart and MasterHand could not confirm whether the continuation landed. Review the session before continuing."
          : "This turn was interrupted by a restart. Continue and the agent will verify the current state first, avoiding heavy work that could trigger another restart."}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Continue the interrupted turn"
        disabled={resume.isPending}
        onPress={() => resume.mutate(sessionID)}
        style={({ pressed }) => [styles.action, (pressed || resume.isPending) && styles.actionPressed]}
      >
        <Text style={styles.actionText}>{resume.isPending ? "Continuing…" : "Continue"}</Text>
      </Pressable>
      {resume.error ? <Text style={styles.error}>The continuation did not start. Try again.</Text> : null}
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    wrap: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 10,
      marginHorizontal: 12,
      marginBottom: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.warningLine,
      backgroundColor: colors.warningSoft,
    },
    error: {
      width: "100%",
      fontFamily: fonts.ui,
      fontSize: 11,
      color: colors.danger,
    },
    text: {
      flex: 1,
      fontFamily: fonts.ui,
      fontSize: 12,
      lineHeight: 17,
      color: colors.textSoft,
    },
    action: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      minHeight: 32,
      justifyContent: "center",
    },
    actionPressed: {
      opacity: 0.6,
    },
    actionText: {
      fontFamily: fonts.ui,
      fontSize: 12,
      color: colors.text,
    },
  })
}
