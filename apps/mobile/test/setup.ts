/**
 * `react-native-safe-area-context` reads the native view config to report
 * insets; under Jest there is no native host, so its shipped Jest mock supplies
 * fixed insets instead. Without this the `SafeAreaView` in `Screen` (and every
 * screen rendered through it) would read zero/garbage insets.
 */
jest.mock("react-native-safe-area-context", () => {
  const mock = jest.requireActual<{ default: unknown }>("react-native-safe-area-context/jest/mock")
  return mock.default
})

/**
 * `react-native-reanimated` drives the board's within-column card drag
 * (#164). Under Jest there is no worklet runtime — and the shipped
 * `react-native-reanimated/mock` cannot load here either (it pulls the real
 * entry point, whose worklets native binding is undefined outside a native
 * host). This hand mock stands in instead: shared values are plain holders,
 * style factories resolve immediately and springs are identity, so render
 * tests assert structure, never animation frames. The drag gesture itself is
 * device-only chrome exercised through the same commit path as the buttons.
 */
jest.mock("react-native-reanimated", () => {
  const { View } = require("react-native")
  const createAnimatedComponent = (component: unknown) => component
  return {
    __esModule: true,
    default: { View, createAnimatedComponent },
    createAnimatedComponent,
    useSharedValue: (initial: unknown) => ({ value: initial }),
    useAnimatedStyle: (factory: () => object) => factory(),
    // Gesture-handler attaches its detectors through these; no-ops under Jest.
    useEvent: () => {},
    setGestureState: () => {},
    withSpring: (value: unknown) => value,
    withTiming: (value: unknown) => value,
    runOnJS: <T extends (...args: Array<never>) => unknown>(fn: T): T => fn,
  }
})
