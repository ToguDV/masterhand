# Runbook — Cutting a release (web/BFF, Android, desktop)

A release is one final `vX.Y.Z` tag. It publishes the server image with the
bundled web app, the signed Android APK + F-Droid repo, and the desktop
installers with their auto-update channel files. Everything is built by
`.github/workflows/release.yml`; the maintainer only bumps versions, tags and
pushes.

## 1. One-time setup

### 1.1 Android signing key

The same key signs every APK **and** the F-Droid repo index. It must never
change and never be committed (see [`fdroid.md`](fdroid.md) §1 for the full
key-custody procedure).

```bash
keytool -genkeypair -alias masterhand -keyalg RSA -keysize 4096 -validity 10950 \
  -keystore masterhand-release.keystore
```

Add these Actions secrets (Settings → Secrets and variables → Actions):

| Secret | Content |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 masterhand-release.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | `masterhand` (or your alias) |
| `ANDROID_KEY_PASSWORD` | Key password |

Back the keystore and both passwords up offline (password manager + an offline
copy). Losing them means a new package identity and an uninstall/reinstall wall
for every user.

### 1.2 Desktop signing (optional)

Without secrets the desktop installers are **unsigned**: Windows shows a
SmartScreen warning, macOS needs the usual Gatekeeper bypass, and **macOS
auto-update does not apply** (Squirrel.Mac requires a signed app). Linux
AppImage auto-update works unsigned. The `.deb` is a manual install
(`sudo apt install ./MasterHand-<version>-amd64.deb`); from the next release
`latest-linux.yml` lists both Linux artifacts, while v0.1.0's channel file
keeps the AppImage only.

| Secret | Content |
|---|---|
| `WINDOWS_CSC_LINK` | Windows code-signing certificate (`.pfx`, base64 or URL) |
| `WINDOWS_CSC_KEY_PASSWORD` | Certificate password |
| `MACOS_CSC_LINK` | Apple Developer ID certificate (`.p12`, base64 or URL) |
| `MACOS_CSC_KEY_PASSWORD` | Certificate password |

The workflow passes the matching pair to `electron-builder` per matrix entry.
Notarization is not wired yet; a signed but unnotarized macOS build still
triggers Gatekeeper.

### 1.3 GitHub Pages for F-Droid

The first release creates the `fdroid` orphan branch. Then enable Pages once:

1. Repository **Settings → Pages → Build and deployment → Deploy from a branch**.
2. Branch **`fdroid`**, folder **`/ (root)`**.

The repo is served at `https://togudv.github.io/masterhand/fdroid/repo/` (the
human landing page is `https://togudv.github.io/masterhand/`). This can also be done with the API once
the branch exists:

```bash
gh api -X POST repos/ToguDV/masterhand/pages \
  --input - <<'JSON'
{"source":{"branch":"fdroid","path":"/"}}
JSON
```

### 1.4 Container package visibility

`GITHUB_TOKEN` pushes `ghcr.io/togudv/masterhand` and
`ghcr.io/togudv/masterhand-updater`. For a public repository the packages
should inherit public visibility; if GHCR shows them private after the first
push, set each package to public (Package settings → Change visibility).
`docker compose pull` fails for anonymous hosts otherwise.

## 2. Cut the release

```bash
git switch main
git pull

# Bumps every package.json + apps/mobile/app.json (version + versionCode),
# deploy/docker-compose.yml and deploy/server.Dockerfile, syncs
# package-lock.json, commits and creates the annotated tag.
node scripts/release.mjs 0.2.1

# Pushing the tag triggers the release workflow.
git push origin main v0.2.1
```

When a release fixes a broken client build, write the recovery step in the tag
annotation (it becomes `version.json.notes` and the GitHub release body).
v0.2.0's Android app cannot open, so its users must update through F-Droid or
download `MasterHand-0.2.1.apk` manually; the in-app update banner is not
reachable.

Rules enforced by the workflow:

- **Final tags only** (`vX.Y.Z`): the semver compare strips suffixes, so a
  prerelease would notify stable users as if it were final.
- Every `package.json` version and `apps/mobile/app.json` `expo.version` must
  equal the tag (`scripts/check-release-versions.mjs`, preflight job).
- `android.versionCode` must equal `major*10000 + minor*100 + patch`
  (`0.2.0` → `200`) and never decreases. The first release `0.1.0` is `100`;
  old APKs stay in the F-Droid repo.
- `apps/desktop/package.json` is the Electron installer version and must match
  the tag (checked by the same preflight).

## 3. What the workflow publishes

| Job | Output |
|---|---|
| `preflight` | Version/versionCode guard; nothing is built when it fails |
| `image` | `ghcr.io/togudv/masterhand:<version>` + `:latest` (web UI bundled), `ghcr.io/togudv/masterhand-updater:<version>` + `:latest`, `version.json` |
| `android` | Signed `MasterHand-<version>.apk` (release asset; F-Droid stores it as `dev.togudv.masterhand_<versionCode>.apk`), verified against the release keystore and gated by the reflective-constructor check |
| `desktop` (Linux) | `MasterHand-<version>.AppImage`, `MasterHand-<version>-amd64.deb`, `latest-linux.yml`, blockmap |
| `desktop` (Windows) | `MasterHand Setup <version>.exe`, `latest.yml`, blockmap |
| `desktop` (macOS) | `MasterHand-<version>-universal.dmg`, `-universal-mac.zip`, `latest-mac.yml`, blockmap |
| `publish` | GitHub release with every asset above + the F-Droid branch update |

The desktop app bundles the same web build and serves it from a privileged
`masterhand://app` origin, so the first run opens the app's **Servers** screen
instead of a shell prompt. The `desktop` job builds the web bundle with the
tag's `MASTERHAND_VERSION`/`MASTERHAND_BUILD`, so its build id matches the
server image. Its `electron-updater` reads `latest*.yml` from the **latest**
GitHub release, downloads in the background and prompts to restart; the
stale-bundle notice is suppressed inside the shell because updating the UI is
the installer's job.

## 4. Verify the release

1. **Workflow:** all jobs green; the GitHub release exists and contains
   `version.json`, the APK, both server images and the desktop assets.
2. **Manifest:** `curl -fsSL .../releases/download/v<version>/version.json` —
   `notes` must be the annotated tag's subject, not a commit message (the image
   job fetches the tag object before reading it; a commit subject means the
   checkout left a lightweight tag, see §7).
3. **Image:** `docker pull ghcr.io/togudv/masterhand:<version>` and check
   `GET /api/status` reports `{ version, build }` on a test host.
4. **Android:** install `MasterHand-<version>.apk` from the release (or F-Droid
   once Pages is on) and **launch it** — it must reach the Servers screen. A
   build can pass the signature check and still crash before `MainActivity`
   (v0.2.0 stripped `WorkDatabase_Impl.<init>` with R8); the `android` job's
   `scripts/check-android-dex.mjs` step is the automated gate, and a manual
   launch catches anything else. The job must also pass the manifest gate
   (`scripts/check-android-manifest.mjs`, right after the dex gate), so a
   release build keeps LAN plain-http working; confirm it by hand with:

   ```bash
   aapt2 dump xmltree --file AndroidManifest.xml MasterHand-<version>.apk | grep -i usesCleartextTraffic
   ```

   Expect `usesCleartextTraffic=true`. Settings → About shows the installed
   version and the update path.
5. **F-Droid:** `curl -fsSL https://togudv.github.io/masterhand/fdroid/repo/index-v2.json`
   and confirm the new `versionCode`.
6. **Desktop:** install the AppImage/EXE/DMG (or the `.deb` on Debian/Ubuntu);
   the first run opens the app's **Servers** screen — add the server URL and
   password there. The native menu only has **Check for updates…** and
   **About**.
7. **Auto-update:** after the *next* release, the desktop app should download
   and prompt; the web banner should offer **Update now** when the one-click
   updater is enabled.

## 5. Rollback

Migrations are forward-only: an older image cannot read a database a newer one
already migrated. There is no automatic rollback.

1. Stop the stack.
2. Restore the pre-update backup from `masterhand_data` (`backups/pre-update-*.sqlite`);
   the one-click updater writes one before every update.
3. Pin `MASTERHAND_VERSION=<previous>` in `deploy/.env` and
   `docker compose up -d`.
4. For Android, never reuse a `versionCode`; ship a new higher version. For
   desktop, bump the version and cut a new release (electron-updater only moves
   forward).

## 6. One-click BFF updater (opt-in)

The updater is a separate Compose profile (`#134`):

```ini
# deploy/.env
MASTERHAND_VERSION=latest            # floating tag required
MASTERHAND_UPDATE_URL=http://updater:8080
MASTERHAND_UPDATE_TOKEN=<openssl rand -hex 32>
```

```bash
docker compose --profile updater up -d
```

The BFF exposes **Update now** in the update banner and Settings → About when
`MASTERHAND_UPDATE_URL`/`TOKEN` are configured and the image tracks `latest`.
Pressing it:

1. Creates `data/backups/pre-update-<version>-<timestamp>.sqlite`.
2. Calls the sidecar, which runs `docker compose pull masterhand` and
   `up -d --no-deps --wait masterhand`.
3. Restarts the BFF; the page reconnects and polls `/api/status` until the new
   version appears (bounded to 5 minutes, then an explicit failure message).

The sidecar is the **only** container with `/var/run/docker.sock` (root
equivalent) and has no published ports; it can only recreate the `masterhand`
service. A pinned `MASTERHAND_VERSION` disables the button and keeps the manual
`docker compose pull && up -d` flow. The opencode engine image is built
locally and is **not** updated by this flow.

## 7. Troubleshooting

- **Preflight fails:** run `node scripts/check-release-versions.mjs vX.Y.Z`
  locally; it names each stale file. Never move a published tag — delete the
  remote tag only if the release job did not create a GitHub release yet.
- **`version.json` notes show a commit message:** the checkout left the tag as a
  lightweight ref, so the annotation was never read (v0.2.0). The `image` job
  re-fetches `refs/tags/$TAG` before reading `%(contents:subject)` (pinned by
  `scripts/release-workflow.test.mjs`). Repair a published manifest in place:
  `gh release delete-asset vX.Y.Z version.json --yes`, upload a corrected file
  named `version.json` (a `file#version.json` label does not rename it), then
  re-download it to confirm.
- **Android job fails on the keystore:** the secrets are missing or the alias
  is wrong; the APK-signature verification step names the mismatch.
- **Android job fails in “Verify the minified APK keeps reflective
  constructors”:** R8 removed `<init>` from `WorkDatabase_Impl` or an
  `InputMerger` (v0.2.0). Restore the `expo-build-properties` keep rules in
  `apps/mobile/app.json` and the SDK-58 `expo-background-task`/
  `expo-task-manager` patches; never publish a release from that failed job.
  The three class names are WorkManager internals: when an upgrade legitimately
  renames one, update `REQUIRED_NO_ARG_CONSTRUCTORS` and the keep rule — never
  delete the step or bypass it.
- **Android job fails in “Verify the APK manifest allows LAN cleartext
  traffic”:** the merged manifest lost `usesCleartextTraffic`, so release builds
  would block every plain-http LAN server. Restore
  `android.usesCleartextTraffic: true` under `expo-build-properties` in
  `apps/mobile/app.json`; never publish that build.
- **Old releases use the Gradle APK name:** v0.1.0 and v0.2.0 attached
  `app-release.apk`; from v0.2.1 the asset is `MasterHand-<version>.apk`. The
  manual F-Droid workflow accepts both (the script falls back to the old name).
- **Desktop packaging fails:** `electron-builder` requires an **exact** Electron
  version (no `^`), and the scoped workspace name is not a valid executable
  name (`executableName: masterhand` is set in `electron-builder.yml`).
- **macOS app is damaged / blocked:** unsigned build; remove the quarantine
  attribute (`xattr -dr com.apple.quarantine /Applications/MasterHand.app`) or
  sign the build.
- **F-Droid repo never updates:** Pages is not enabled, or the release job
  pushed the `fdroid` branch but Pages points at the wrong branch.
- **No update button:** the updater is not configured, the token is empty, or
  the image tag is pinned. `GET /api/status` reports
  `updater: { enabled, tracksLatest, track }`.
