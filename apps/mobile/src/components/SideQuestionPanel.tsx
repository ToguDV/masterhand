import { useMessages, type Client } from "@masterhand/client-core"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { MessageBubble } from "./MessageBubble"
import { useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * Temporary `/btw` side question: shows the answer streaming from a forked
 * session. The fork is discarded when the panel closes, so the main chat is
 * never touched.
 */
export function SideQuestionPanel({
  client,
  sessionID,
  question,
  connected,
  onClose,
}: {
  client: Client
  sessionID: string
  question: string
  connected: boolean
  onClose: () => void
}) {
  const styles = useThemedStyles(createStyles)
  const messagesQuery = useMessages(client, sessionID, { connected, busy: true })
  const messages = messagesQuery.data ?? []
  const reply = [...messages].reverse().find((entry) => entry.info.role === "assistant")

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Side question</Text>
        <Text style={styles.question} numberOfLines={1}>
          {question}
        </Text>
        <Pressable
          onPress={onClose}
          style={styles.close}
          accessibilityRole="button"
          accessibilityLabel="Close side question"
        >
          <Text style={styles.closeText}>Close</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.body} nestedScrollEnabled>
        {reply ? <MessageBubble entry={reply} /> : <Text style={styles.thinking}>Thinking…</Text>}
      </ScrollView>
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    container: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 10,
      gap: 8,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    title: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 11,
      fontWeight: "600",
      letterSpacing: 0.8,
      textTransform: "uppercase",
    },
    question: {
      flex: 1,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    close: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    closeText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 11,
    },
    body: {
      maxHeight: 220,
    },
    thinking: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
      paddingVertical: 4,
    },
  })
}
