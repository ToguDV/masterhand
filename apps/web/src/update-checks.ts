/** Persisted "check for updates automatically" choice (defaults to on). */
const UPDATE_CHECKS_KEY = "masterhand.updateChecks"

export function loadUpdateChecksEnabled(): boolean {
  try {
    return window.localStorage.getItem(UPDATE_CHECKS_KEY) !== "0"
  } catch {
    return true
  }
}

export function saveUpdateChecksEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(UPDATE_CHECKS_KEY, enabled ? "1" : "0")
  } catch {
    // Private mode: the choice lives in memory for this tab only.
  }
}
