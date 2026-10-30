#!/usr/bin/env bash
#
# Rebuild the self-hosted F-Droid repo (the `fdroid` branch) from a published
# GitHub release. Used by the release workflow and by the manual `F-Droid repo`
# repair workflow.
#
# Requirements on PATH: `git`, `gh` (only when APK_SOURCE is not set), `fdroid`
# (fdroidserver), Java and the Android build-tools (`apksigner`/`aapt`); the
# workflows install them. The keystore and passwords come from Actions secrets.
#
# Layout (GitHub Pages serves the branch root):
#   .nojekyll
#   index.html                      human landing page
#   fdroid/config.yml               committed, never carries passwords
#   fdroid/icon.png
#   fdroid/metadata/<pkg>.yml
#   fdroid/repo/index-v2.json       <- F-Droid repo URL: .../fdroid/repo/
#   fdroid/repo/*.apk
set -euo pipefail

TAG="${TAG:?TAG is required}"
VERSION_CODE="${VERSION_CODE:?VERSION_CODE is required}"
APK_SOURCE="${APK_SOURCE:-}"
FDROID_REPO_URL="${FDROID_REPO_URL:-https://togudv.github.io/masterhand/fdroid/repo}"

: "${ANDROID_KEYSTORE_BASE64:?ANDROID_KEYSTORE_BASE64 is required}"
: "${ANDROID_KEYSTORE_PASSWORD:?ANDROID_KEYSTORE_PASSWORD is required}"
: "${ANDROID_KEY_ALIAS:?ANDROID_KEY_ALIAS is required}"
: "${ANDROID_KEY_PASSWORD:?ANDROID_KEY_PASSWORD is required}"

# The icon comes from the tagged desktop commit; the manual workflow checks out
# main, so make sure the tag object is available before `git show`.
git fetch --tags --force origin

git fetch origin fdroid || true
if git rev-parse --verify origin/fdroid >/dev/null 2>&1; then
  git checkout fdroid
else
  git checkout --orphan fdroid
  git rm -rf . || true
fi

mkdir -p fdroid/repo fdroid/metadata
APK="fdroid/repo/dev.togudv.masterhand_${VERSION_CODE}.apk"
if [ -n "$APK_SOURCE" ]; then
  cp "$APK_SOURCE" "$APK"
else
  gh release download "$TAG" --pattern app-release.apk --output "$APK"
fi
git show "$TAG:apps/desktop/assets/icon.png" > fdroid/icon.png
touch .nojekyll

if [ ! -f index.html ]; then
  cat > index.html <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MasterHand F-Droid repo</title>
    <style>
      body { margin: 2rem auto; max-width: 42rem; padding: 0 1rem; font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.6; }
      code { overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <h1>MasterHand F-Droid repo</h1>
    <p>Add this repository in F-Droid → Settings → Repositories:</p>
    <p><code>https://togudv.github.io/masterhand/fdroid/repo/</code></p>
    <p>
      Or download the signed APK from
      <a href="https://github.com/ToguDV/masterhand/releases/latest">GitHub Releases</a>.
    </p>
  </body>
</html>
EOF
fi

if [ ! -f fdroid/metadata/dev.togudv.masterhand.yml ]; then
  cat > fdroid/metadata/dev.togudv.masterhand.yml <<'EOF'
Categories:
  - Development
License: MIT
AuthorName: ToguDV
WebSite: https://github.com/ToguDV/masterhand
SourceCode: https://github.com/ToguDV/masterhand
IssueTracker: https://github.com/ToguDV/masterhand/issues
Summary: Self-hosted UI for your opencode agents
Description: Use your opencode agents from web, desktop and Android through your own MasterHand server.
EOF
fi

if [ ! -f fdroid/config.yml ]; then
  cat > fdroid/config.yml <<EOF
repo_url: "$FDROID_REPO_URL"
repo_name: "MasterHand"
repo_icon: "icon.png"
repo_keyalias: "$ANDROID_KEY_ALIAS"
keystore: "repo.keystore"
EOF
else
  # Keep the committed config canonical without ever adding the passwords.
  sed -i "s|^repo_url:.*|repo_url: \"$FDROID_REPO_URL\"|" fdroid/config.yml
  sed -i "s|^repo_keyalias:.*|repo_keyalias: \"$ANDROID_KEY_ALIAS\"|" fdroid/config.yml
  grep -q '^keystore:' fdroid/config.yml || echo 'keystore: "repo.keystore"' >> fdroid/config.yml
fi

# fdroidserver reads the passwords from config.yml. Use a throwaway copy so the
# committed file (pushed to the public branch) is always secret-free.
cp fdroid/config.yml fdroid/config.yml.keep
chmod 600 fdroid/config.yml
cat >> fdroid/config.yml <<EOF
keystorepass: "$ANDROID_KEYSTORE_PASSWORD"
keypass: "$ANDROID_KEY_PASSWORD"
EOF
echo "$ANDROID_KEYSTORE_BASE64" | base64 -d > fdroid/repo.keystore

(cd fdroid && fdroid update -c)

mv fdroid/config.yml.keep fdroid/config.yml
rm -f fdroid/repo.keystore
# fdroidserver writes per-run caches/status files; never commit them.
rm -rf fdroid/tmp fdroid/repo/status
git add index.html .nojekyll fdroid
if git diff --cached --quiet; then
  echo "F-Droid repo unchanged"
else
  git -c user.name="MasterHand release" -c user.email="masterhand@localhost" \
    commit -m "F-Droid repo for $TAG (versionCode $VERSION_CODE)"
  git push origin fdroid
fi
