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
 * (#164). Under Jest there is no worklet runtime, so the shipped mock stands
 * in: animated styles resolve to plain styles and render tests assert
 * structure, not animation frames.
 */
jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"))
