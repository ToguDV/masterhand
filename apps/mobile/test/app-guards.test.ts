/**
 * Static guards for the mobile app.
 *
 * These defects only show up on a device or in Expo Go — the browser E2E suite
 * and the coverage gate cannot reach them — so the source-level checks below
 * keep them from creeping back in:
 *
 * - React Native removes deprecated APIs in later releases, so `SafeAreaView`
 *   (and friends) must not be imported from `react-native`.
 * - `react-native-safe-area-context` only works with its provider mounted, and
 *   the bottom inset has to be dropped while the keyboard is up.
 * - Since edge-to-edge became mandatory on Android (Expo SDK 54 / RN 0.86) the
 *   window no longer resizes for the keyboard, so the screen shell must keep a
 *   `KeyboardAvoidingView` or the composer ends up behind the IME.
 * - Native has no DOM events: the app must reconnect the stream itself when it
 *   returns to the foreground.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const appRoot = join(__dirname, "..")

function read(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), "utf8")
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

const sourceFilesList = [...sourceFiles(join(appRoot, "src")), join(appRoot, "App.tsx")]

/** Names imported from `module` across every import statement of a source file. */
function importedNames(source: string, module: string): string[] {
  const pattern = new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+"${module}"`, "g")
  return [...source.matchAll(pattern)].flatMap((match) =>
    (match[1] ?? "")
      .split(",")
      .map((name) => name.replace(/\s+as\s+.*$/, "").trim())
      .filter(Boolean),
  )
}

function offenders(names: string[]): string[] {
  return sourceFilesList.flatMap((file) => {
    const imported = importedNames(readFileSync(file, "utf8"), "react-native")
    return names
      .filter((name) => imported.includes(name))
      .map((name) => `${relative(appRoot, file)} imports ${name}`)
  })
}

describe("react-native APIs", () => {
  it("never imports SafeAreaView from react-native (deprecated)", () => {
    expect(offenders(["SafeAreaView"])).toEqual([])
  })

  it("never imports modules React Native already removed", () => {
    const removed = [
      "AsyncStorage",
      "Clipboard",
      "DatePickerIOS",
      "ListView",
      "MaskedViewIOS",
      "PickerIOS",
      "Slider",
      "ViewPropTypes",
      "WebView",
    ]
    expect(offenders(removed)).toEqual([])
  })

  it("keeps SafeAreaProvider mounted at the app root", () => {
    const app = read("App.tsx")
    expect(app).toContain("<SafeAreaProvider>")
    expect(app).toContain("</SafeAreaProvider>")
  })

  it("uses the safe-area-context SafeAreaView in Screen", () => {
    expect(importedNames(read("src/components/Screen.tsx"), "react-native-safe-area-context")).toContain(
      "SafeAreaView",
    )
  })

  it("declares react-native-safe-area-context as a dependency", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies?.["react-native-safe-area-context"]).toBeTruthy()
  })
})

describe("keyboard handling", () => {
  it("keeps the keyboard from covering bottom-pinned inputs", () => {
    const screen = read("src/components/Screen.tsx")
    expect(importedNames(screen, "react-native")).toContain("KeyboardAvoidingView")
    expect(screen).toMatch(/behavior="padding"/)
  })

  it("drops the bottom safe-area inset while the keyboard is up", () => {
    const screen = read("src/components/Screen.tsx")
    // The insets are conditional on the keyboard: the keyboard already covers
    // the navigation-bar strip, so keeping the inset would float the input.
    expect(screen).toMatch(/edges=\{[^}]*keyboardVisible/)
    expect(screen).toMatch(/keyboardDidShow|keyboardWillShow/)
  })
})

describe("foreground recovery", () => {
  it("reconnects the event stream when the app becomes active again", () => {
    const app = read("App.tsx")
    expect(app).toMatch(/AppState\.addEventListener\(\s*"change"/)
    expect(app).toMatch(/forceReconnect\(\)/)
  })
})

describe("design system", () => {
  it("has no indigo palette left (the ink-on-paper port replaced it)", () => {
    const offenders = sourceFilesList
      .filter((file) => {
        const source = readFileSync(file, "utf8").toLowerCase()
        return source.includes("#6366f1") || source.includes("#312e81")
      })
      .map((file) => relative(appRoot, file))
    expect(offenders).toEqual([])
  })

  it("keeps the theme provider mounted at the app root", () => {
    const app = read("App.tsx")
    expect(app).toContain("<ThemeProvider")
    expect(app).toContain("</ThemeProvider>")
  })
})
