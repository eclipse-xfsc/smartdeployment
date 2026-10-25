#!/bin/sh
set -eu
# Dependencies and the Vue bundle are installed while building the image.
# No npm invocation or external download is permitted during pod startup.
SOURCE=/opt/ocm/runtime
[ -f "$SOURCE/RELEASE.sha256" ] || { echo 'OCM image has not been built.' >&2; exit 1; }
[ -f "$SOURCE/uibuilder/orce/dist/.vite/manifest.json" ] || { echo 'Vue production bundle is missing.' >&2; exit 1; }
RELEASE_HASH="$(cat "$SOURCE/RELEASE.sha256")"
RELEASE="/data/releases/$RELEASE_HASH"
mkdir -p /data/releases
if [ ! -f "$RELEASE/.ready" ]; then
  mkdir -p "$RELEASE"
  cp -R "$SOURCE/." "$RELEASE/"
  touch "$RELEASE/.ready"
fi
# Existing 12.3.17 and earlier flows are not silently reused. The migration procedure requires
# an isolated UI data volume; operator-created flows must be exported separately.
if [ -f /data/flows.json ] && [ ! -f /data/OCM-UI-V3-MANAGED ]; then
  echo 'An existing flow volume requires the documented 12.3.18 migration.' >&2
  exit 1
fi
ln -sfn "$RELEASE" /data/current-new
mv -Tf /data/current-new /data/current
for entry in node_modules lib uibuilder; do
  ln -sfn "current/$entry" "/data/$entry-new"
  mv -Tf "/data/$entry-new" "/data/$entry"
done
cp "$RELEASE/flows.json" /data/flows.json
cp "$RELEASE/package.json" /data/package.json
printf '%s\n' "module.exports = require('/data/current/settings.js');" > /data/settings.js
touch /data/OCM-UI-V3-MANAGED
