const { moduleNameMapper } = require("jest-expo/jest-preset")

/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo",
  testMatch: ["<rootDir>/test/**/*.test.{ts,tsx}"],
  // `react-native-gesture-handler` ships its own Jest setup (native module
  // mocks); it runs before the preset's setup via concatenation.
  setupFiles: ["react-native-gesture-handler/jestSetup"],
  setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
  // React Native render tests are slow under coverage on CI runners; the 5s
  // default made unrelated suites (Composer, ChatScreen) flake with timeouts.
  testTimeout: 30000,
  // Keep the preset's react-native mappings and add the ESM-only SDK stub.
  moduleNameMapper: {
    ...moduleNameMapper,
    "^@opencode/client$": "<rootDir>/test/mocks/opencode-client.ts",
    "^@ronradtke/react-native-markdown-display$":
      "<rootDir>/test/mocks/react-native-markdown-display.tsx",
    "^react-native-webview$": "<rootDir>/test/mocks/react-native-webview.tsx",
  },
  collectCoverageFrom: ["src/**/*.{ts,tsx}", "App.tsx", "!src/theme.ts"],
  // A floor for the render suite (root `test:coverage` runs with --coverage).
  coverageThreshold: {
    global: { statements: 90, branches: 80, functions: 88, lines: 92 },
  },
}
