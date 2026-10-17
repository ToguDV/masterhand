import { defineConfig } from "vitest/config"

/**
 * Render tests for the web components. The workspace has no runtime deps of
 * its own for tooling: vitest, @testing-library/react, jsdom and the v8
 * coverage provider resolve from the hoisted root node_modules.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/components/SchedulerPanel.tsx"],
    },
  },
})
