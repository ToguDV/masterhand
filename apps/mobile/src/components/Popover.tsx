import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
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
/** Last-resort open delay when the native measurement never answers. */
const MEASURE_FALLBACK_MS = 120

export interface PopoverViewport {
  width: number
  height: number
  keyboardInset: number
}

export interface PopoverLayout {
  width: number
  left: number
  top: number | undefined
  bottom: number | undefined
  maxHeight: number
}

/**
 * Pure placement math for the anchored card. Kept separate from the component
 * so the no-shift contract (one calculation per open) can be unit-tested.
 */
export function popoverLayout(
  anchor: PopoverAnchor | null,
  placement: "up" | "down",
  viewport: PopoverViewport,
): PopoverLayout {
  const visibleBottom = viewport.height - viewport.keyboardInset
  const width = Math.min(MENU_WIDTH, viewport.width - EDGE * 2)
  const left = anchor ? Math.min(Math.max(anchor.x, EDGE), viewport.width - width - EDGE) : EDGE
  const anchorTop = anchor?.y ?? (placement === "up" ? visibleBottom - 160 : 48)
  const triggerTop = Math.min(anchorTop, visibleBottom)
  const triggerBottom = anchor ? Math.min(anchor.y + anchor.height, visibleBottom) : triggerTop + 32
  const cardBottom = triggerTop - GAP
  const top = placement === "down" ? triggerBottom + GAP : undefined
  const bottom = placement === "up" ? Math.max(EDGE, viewport.height - cardBottom) : undefined
  const maxHeight =
    placement === "up"
      ? Math.max(MIN_HEIGHT, cardBottom - EDGE)
      : Math.max(MIN_HEIGHT, visibleBottom - triggerBottom - GAP - EDGE)
  return { width, left, top, bottom, maxHeight }
}

/**
 * Anchor bookkeeping for a popover trigger. The trigger measures itself on
 * layout and press-in; `show` waits for that measurement when it is the first
 * open, so the card is never painted at the fallback position first.
 * Under Jest there is no native measurement: the card keeps the fallback
 * placement.
 */
export function usePopover() {
  const triggerRef = useRef<HostInstance | null>(null)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null)
  const openRef = useRef(false)
  const anchorRef = useRef<PopoverAnchor | null>(null)
  /** True while the first open is waiting for its measurement. */
  const pendingRef = useRef(false)
  /** Once the fallback painted, a late measurement must not move the card. */
  const lockedRef = useRef(false)
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current)
    },
    [],
  )

  function updateAnchor(next: PopoverAnchor | null): void {
    anchorRef.current = next
    setAnchor(next)
  }

  /**
   * Measures the trigger. While the popover is open a measurement is ignored
   * unless it belongs to the first open still waiting for its anchor: a
   * modal-driven layout change must not move an already visible card.
   */
  function measure(callback?: (next: PopoverAnchor | null) => void): void {
    const node = triggerRef.current
    if (!node || typeof node.measureInWindow !== "function") {
      callback?.(anchorRef.current)
      return
    }
    node.measureInWindow((x, y, width, height) => {
      const allowed = !openRef.current || (pendingRef.current && !lockedRef.current)
      if (!allowed) return
      const next = width > 0 && height > 0 ? { x, y, width, height } : anchorRef.current
      if (next) updateAnchor(next)
      callback?.(next)
    })
  }

  function openNow(): void {
    if (openRef.current) return
    openRef.current = true
    setOpen(true)
  }

  /**
   * Opens immediately so the menu never feels laggy, but keeps the first open
   * pending until the trigger measurement lands. `Popover` hides the card for
   * that one frame instead of painting it at the fallback position first; a
   * short timeout prevents a broken native callback from leaving it invisible.
   */
  function show(): void {
    if (openRef.current) return
    pendingRef.current = anchorRef.current === null
    lockedRef.current = false
    openNow()
    if (!pendingRef.current) return

    const timer = setTimeout(() => {
      if (pendingRef.current) {
        pendingRef.current = false
        lockedRef.current = true
      }
    }, MEASURE_FALLBACK_MS)
    fallbackTimer.current = timer
    measure((next) => {
      if (!pendingRef.current) return
      pendingRef.current = false
      clearTimeout(timer)
      if (fallbackTimer.current === timer) fallbackTimer.current = null
      if (next) updateAnchor(next)
    })
  }

  function hide(): void {
    openRef.current = false
    pendingRef.current = false
    lockedRef.current = false
    if (fallbackTimer.current) clearTimeout(fallbackTimer.current)
    fallbackTimer.current = null
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
 *
 * Geometry is frozen when the popover opens. The Modal can change the window
 * metrics (keyboard dismissal, navigation insets) while it is appearing; a
 * live calculation would visibly move the card after its first paint.
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
  const [revealed, setRevealed] = useState(false)
  const currentViewport: PopoverViewport = {
    width: window.width,
    height: window.height,
    keyboardInset,
  }
  // Captured once per open: a keyboard dismissal or inset change while the
  // Modal appears must not move the already painted card. The dependency list
  // is intentionally only `open` (the viewport is the value at open time).
  const frozenViewport = useMemo(() => (open ? currentViewport : null), [open])
  const layout = popoverLayout(anchor, placement, frozenViewport ?? currentViewport)

  useEffect(() => {
    if (!open) {
      setRevealed(false)
      return
    }
    if (anchor) {
      setRevealed(true)
      return
    }
    const timer = setTimeout(() => setRevealed(true), MEASURE_FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [open, anchor])

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
          testID="popover-card"
          style={[
            styles.card,
            { width: layout.width, left: layout.left, maxHeight: layout.maxHeight },
            layout.top !== undefined ? { top: layout.top } : { bottom: layout.bottom },
            // First open without an anchor yet: stay transparent instead of
            // painting the fallback position and moving a frame later.
            { opacity: revealed || anchor !== null ? 1 : 0 },
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
