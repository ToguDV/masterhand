/**
 * React Native 0.88 moved the asset registry to `src/private/assets`, which
 * `jest-expo`'s preset does not mock (it still mocks the legacy
 * `react-native/asset-registry` entry point). `expo-asset` reaches the
 * registry through the `react-native` root, so without this every font load
 * (`expo-font`, `@expo/vector-icons`, the Google-font `useFonts` in `App`)
 * throws `Module "1" is missing from the asset registry` under Jest. The
 * metadata shape mirrors `jest-expo`'s own mock: enough for
 * `resolveAssetSource`/`selectAssetSource` to build a URI.
 */
jest.mock("react-native/src/private/assets/AssetRegistry", () => ({
  AssetRegistry: {
    registerAsset: jest.fn(() => 1),
    getAssetByID: jest.fn(() => ({
      fileSystemLocation: "/full/path/to/directory",
      httpServerLocation: "/assets/full/path/to/directory",
      scales: [1],
      fileHashes: ["md5"],
      name: "name",
      exists: true,
      type: "type",
      hash: "md5",
      uri: "uri",
      width: 1,
      height: 1,
    })),
  },
}))

/**
 * `react-native-gesture-handler` v3 builds `ScrollView` and `GestureDetector`
 * on the reanimated worklet runtime (`useComposedEventHandler`), which does
 * not exist under Jest — and the shipped `jestSetup` only mocks the native
 * modules, not the JS detectors. v2 merely warned outside a
 * `GestureHandlerRootView`; v3 throws. The drag gesture itself is
 * device-only chrome exercised through the same commit path as the buttons
 * (see the reanimated mock below), so render tests stand in passthroughs:
 * detectors render their children, `ScrollView` is React Native's own, and
 * any gesture builder chains without doing anything.
 */
jest.mock("react-native-gesture-handler", () => {
  const React = require("react")
  const { ScrollView: RNScrollView, View } = require("react-native")
  const chainStub: unknown = new Proxy(
    {},
    {
      get: (target, property) => {
        if (property === "then") return undefined
        if (property in (target as object)) return (target as Record<PropertyKey, unknown>)[property]
        return () => chainStub
      },
    },
  )
  const gestureFactory = () => chainStub
  return {
    __esModule: true,
    GestureHandlerRootView: ({ children, style }: { children: React.ReactNode; style: unknown }) =>
      React.createElement(View, { style }, children),
    GestureDetector: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Gesture: {
      Pan: gestureFactory,
      Tap: gestureFactory,
      LongPress: gestureFactory,
      Native: gestureFactory,
      Manual: gestureFactory,
      Race: gestureFactory,
      Simultaneous: gestureFactory,
      Exclusive: gestureFactory,
    },
    ScrollView: RNScrollView,
  }
})

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
