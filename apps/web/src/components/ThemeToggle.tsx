import { useEffect, useState } from "react"
import { MoonIcon, SunIcon } from "./icons"

const THEME_STORAGE_KEY = "mh-theme"
const THEME_COLORS = { light: "#fafaf7", dark: "#0c0c0b" } as const

function storedTheme(): "light" | "dark" | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    return value === "light" || value === "dark" ? value : null
  } catch {
    return null
  }
}

function currentTheme(): "light" | "dark" {
  const attribute = document.documentElement.getAttribute("data-theme")
  if (attribute === "dark" || attribute === "light") return attribute
  // No pre-paint resolution (file:// or private mode): fall back to the system.
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

/** Applies the theme to the document and keeps the browser chrome in sync. */
function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.setAttribute("data-theme", theme)
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = THEME_COLORS[theme]
  }
}

/**
 * Light/dark switch. The choice is persisted under `mh-theme` (index.html
 * resolves it before first paint); until the user makes one, the theme keeps
 * following the system.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme)

  useEffect(() => {
    // Sync the metas with the resolved theme (and fix a missing data-theme).
    applyTheme(currentTheme())
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    function onSystemChange(event: MediaQueryListEvent): void {
      if (storedTheme()) return
      const next = event.matches ? "dark" : "light"
      applyTheme(next)
      setTheme(next)
    }
    media.addEventListener("change", onSystemChange)
    return () => media.removeEventListener("change", onSystemChange)
  }, [])

  function toggle(): void {
    const next = currentTheme() === "dark" ? "light" : "dark"
    applyTheme(next)
    setTheme(next)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // storage may be unavailable (private mode)
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="mh-btn mh-btn--icon"
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
    >
      {theme === "dark" ? <SunIcon size={18} /> : <MoonIcon size={18} />}
    </button>
  )
}
