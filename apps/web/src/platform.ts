/**
 * True when the page runs inside the Electron shell: the bundled web build in
 * packaged apps, the Vite dev server in development.
 *
 * The shell exposes this one flag through its preload (no IPC). It changes
 * four behaviors: the first-run screen skips the same-origin probe (the
 * bundled `masterhand://app` origin has no `/api`), plain-http LAN servers
 * stay available (there is no serving cookie origin), the stale-bundle notice
 * is suppressed because the shell updates the UI with `electron-updater`, and
 * device registrations are labeled "Desktop app".
 */
export function isBundledDesktop(): boolean {
  return Boolean((globalThis as { masterhandDesktop?: unknown }).masterhandDesktop)
}
