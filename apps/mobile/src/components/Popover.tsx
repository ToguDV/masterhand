import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type HostInstance,
} from "react-native"
import { useThemedStyles, type Palette } from "../theme"

/** Screen-space rectangle of the control a popover hangs from. */
export interface PopoverAnchor {
  x: number
  y: number
  width: number
  height: number
}

/** Card width, mirroring the web menus (`w-72` = 288px). */
const MENU_WIDTH = 288
const GAP = 6
const EDGE = 8
/** Never let the card shrink below a usable list height. */
const MIN_HEIGHT = 160

/**
 * Anchor bookkeeping for a popover trigger. `show` opens immediately (the
 * menu must never depend on a native measurement callback) and measures the
 * trigger in window coordinates so the card hangs from the control; triggers
 * can also call `measure` on press-in so the position is ready before release.
 * Under Jest there is no native measurement: the card keeps the fallback
 * placement.
 */
export function usePopover() {
  const triggerRef = useRef<HostInstance | null>(null)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null)

  function measure(): void {
    const node = triggerRef.current
    if (!node || typeof node.measureInWindow !== "function") return
    node.measureInWindow((x, y, width, height) => {
      if (width <= 0 || height <= 0) return
      setAnchor({ x, y, width, height })
    })
  }

  function show(): void {
    measure()
    setOpen(true)
  }

  function hide(): void {
    setOpen(false)
  }

  return { triggerRef, open, anchor, show, hide, measure, toggle: () => (open ? hide() : show()) }
}

/**
 * The soft keyboard is an overlay on iOS and on Android with edge-to-edge
 * (the app's `Screen` shell documents that the window no longer resizes for
 * the IME), so the popover lifts above it instead of hiding behind it.
 */
function useKeyboardInset(): number {
  const [height, setHeight] = useState(() => Keyboard.metrics()?.height ?? 0)

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (event) => setHeight(event.endCoordinates.height),
    )
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setHeight(0),
    )
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])

  return height
}

/**
 * The native counterpart of the web menus (`SearchSelect` / `WorkspacePicker`):
 * a transparent scrim plus a compact card anchored above or below its trigger.
 * The scrim only dismisses; the card is the interactive surface.
 */
export function Popover({
  open,
  anchor,
  placement = "down",
  onClose,
  children,
}: {
  open: boolean
  anchor: PopoverAnchor | null
  placement?: "up" | "down"
  onClose: () => void
  children: ReactNode
}) {
  const styles = useThemedStyles(createStyles)
  const window = useWindowDimensions()
  const keyboardInset = useKeyboardInset()
  const visibleBottom = window.height - keyboardInset
  const width = Math.min(MENU_WIDTH, window.width - EDGE * 2)
  const left = anchor ? Math.min(Math.max(anchor.x, EDGE), window.width - width - EDGE) : EDGE
  const anchorTop = anchor?.y ?? (placement === "up" ? visibleBottom - 160 : 48)
  const triggerTop = Math.min(anchorTop, visibleBottom)
  const triggerBottom = anchor ? Math.min(anchor.y + anchor.height, visibleBottom) : triggerTop + 32
  const cardBottom = triggerTop - GAP
  const top = placement === "down" ? triggerBottom + GAP : undefined
  const bottom = placement === "up" ? Math.max(EDGE, window.height - cardBottom) : undefined
  const maxHeight =
    placement === "up"
      ? Math.max(MIN_HEIGHT, cardBottom - EDGE)
      : Math.max(MIN_HEIGHT, visibleBottom - triggerBottom - GAP - EDGE)

  return (
    <Modal visible={open} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.root} accessibilityViewIsModal onAccessibilityEscape={onClose}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
        />
        <View
          style={[
            styles.card,
            { width, left, maxHeight },
            top !== undefined ? { top } : { bottom },
          ]}
        >
          {children}
        </View>
      </View>
    </Modal>
  )
}

function createStyles(colors: Palette) {
  return StyleSheet.create({
    root: {
      flex: 1,
    },
    card: {
      position: "absolute",
      padding: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 8,
      backgroundColor: colors.surface,
      shadowColor: "#000",
      shadowOpacity: 0.18,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 8 },
      elevation: 12,
    },
  })
}
