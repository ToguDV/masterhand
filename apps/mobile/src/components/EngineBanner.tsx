import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { useBffStatus, engineAvailability, type Client } from "@masterhand/client-core"
import { useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * Mobile resilience banner: the same supervisor state the web shell shows.
 * The chat card handles the per-turn **Continue**; this covers restarting, the
 * circuit (with Start engine) and the last incident/memory pressure.
 */
export function EngineBanner({ client }: { client: Client }) {
  const status = useBffStatus(client, 15_000)
  const styles = useThemedStyles(createStyles)
  const [busy, setBusy] = useState(false)
  const engine = status.data?.engine
  if (!engine) return null
  const incident = engine.lastIncident
  const recentIncident = incident && Date.now() - incident.at < 10 * 60_000 ? incident : null
  const serverIncident = engine.serverIncident
  const recentServer = serverIncident && Date.now() - serverIncident.at < 10 * 60_000 ? serverIncident : null
  const availability = engineAvailability(engine)
  const engineStopped = availability === "stopped"
  const engineUnseen = availability === "unknown"
  if (
    !engine.restarting &&
    !engine.circuitOpen &&
    !recentIncident &&
    !engine.serverCircuitOpen &&
    !recentServer &&
    !engine.memoryWarning &&
    !engineStopped &&
    !engineUnseen
  ) {
    return null
  }
  async function startEngine(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await client.api.restartEngine()
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      await status.refetch()
    } catch {
      // The next poll shows the state; the web banner has the detailed copy.
    } finally {
      setBusy(false)
    }
  }
  const message = engine.restarting
    ? "The agent engine is restarting…"
    : engine.circuitOpen
      ? "The agent engine stopped after repeated crashes. Start it to reset the restart budget."
      : engineStopped
        ? "The agent engine is stopped. Start it to continue working."
        : engineUnseen
          ? "The server cannot see the agent engine — check the resilience supervisor (watchdog) on the server."
          : recentIncident
          ? `The agent engine restarted (attempt ${recentIncident.attempt} of ${engine.maxAttempts}). Interrupted conversations can be continued from the chat.`
          : engine.serverCircuitOpen
            ? "MasterHand restarted after repeated crashes; the restart budget resets after 5 minutes of health."
            : recentServer
              ? "MasterHand restarted after a crash. Your work was recovered where possible."
              : "The agent engine is near its memory limit. Avoid heavy work until it settles."
  return (
    <View style={styles.wrap} accessibilityRole="alert">
      <Text style={styles.text}>{message}</Text>
      {engine.circuitOpen || engineStopped ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start the agent engine"
          disabled={busy}
          onPress={() => void startEngine()}
          style={({ pressed }) => [styles.action, (pressed || busy) && styles.actionPressed]}
        >
          <Text style={styles.actionText}>{busy ? "Starting…" : "Start engine"}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    wrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
      backgroundColor: colors.surfaceMuted,
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
