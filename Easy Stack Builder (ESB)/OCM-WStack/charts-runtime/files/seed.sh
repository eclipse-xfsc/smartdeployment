#!/bin/sh
set -eu
export npm_config_cache=/tmp/npm-cache
export npm_config_update_notifier=false
SEED_HASH="$(sha256sum /seed/runtime.tgz | cut -d ' ' -f 1)"
RELEASE="/data/releases/$SEED_HASH"
mkdir -p /data/releases
if [ ! -f "$RELEASE/.ready" ]; then
  mkdir -p "$RELEASE"
  tar -xzf /seed/runtime.tgz -C "$RELEASE"
  cd "$RELEASE"
  npm install --omit=dev --ignore-scripts --no-audit --no-fund --fetch-retries=3 --fetch-retry-mintimeout=3000 --fetch-retry-maxtimeout=20000 > /tmp/npm-install.log 2>&1 || { echo 'Runtime dependency installation failed; check registry access.' >&2; exit 1; }
  cp node_modules/vue/dist/vue.runtime.esm-browser.prod.js uibuilder/orce/dist/vue.js
  touch .ready
fi
ln -sfn "$RELEASE" /data/current-new
mv -Tf /data/current-new /data/current
for entry in node_modules lib uibuilder; do
  if [ ! -e "/data/$entry" ] && [ ! -L "/data/$entry" ]; then ln -s "current/$entry" "/data/$entry"; fi
done
if [ ! -f /data/flows.json ]; then cp "$RELEASE/flows.json" /data/flows.json; fi
if [ ! -f /data/package.json ]; then cp "$RELEASE/package.json" /data/package.json; fi
printf '%s\n' "module.exports = require('/data/current/settings.js');" > /data/settings.js
