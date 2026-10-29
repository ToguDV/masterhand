/**
 * Release identity of this web bundle (#131). Baked in at build time through
 * the `MASTERHAND_VERSION`/`MASTERHAND_BUILD` build args (see
 * `vite.config.ts`); local builds report the package version with a `dev`
 * build id. The desktop shell serves this same bundle, so it inherits the
 * update notices for free — no `electron-updater` in Phase 4.
 */
declare const __MASTERHAND_VERSION__: string | undefined
declare const __MASTERHAND_BUILD__: string | undefined

export const CLIENT_VERSION: string =
  typeof __MASTERHAND_VERSION__ === "string" && __MASTERHAND_VERSION__ ? __MASTERHAND_VERSION__ : "0.1.0"

export const CLIENT_BUILD: string =
  typeof __MASTERHAND_BUILD__ === "string" && __MASTERHAND_BUILD__ ? __MASTERHAND_BUILD__ : "dev"
