#!/bin/sh
set -eu

DATA=${OCM_DATA_DIR:-/data}
SEED=${OCM_SEED_DIR:-/seed}
export npm_config_cache=${npm_config_cache:-/tmp/npm-cache}

# Refuse to replace an independently managed Node-RED installation.
if [ -f "$DATA/flows.json" ] && [ ! -f "$DATA/OCM-UI-V3-MANAGED" ]; then
  echo 'The existing flow volume is not managed by this OCM deployment.' >&2
  exit 1
fi
for entry in current node_modules lib uibuilder; do
  if [ -e "$DATA/$entry" ] && [ ! -L "$DATA/$entry" ]; then
    echo "The existing $entry path is not an OCM release link." >&2
    exit 1
  fi
done

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (!((a===20&&b>=19)||(a===22&&b>=12)||a>22)) { console.error("Runtime setup requires Node 20.19+ or 22.12+."); process.exit(1); }'
RUNTIME=$(node -p 'process.versions.node+"/"+process.platform+"/"+process.arch')
HASH=$({ sha256sum "$SEED/runtime.tgz" "$SEED/ui.tgz" "$SEED/seed.sh" | cut -d ' ' -f 1; printf '%s\n' "$RUNTIME" "${OCM_BASE_IMAGE:-}"; } | sha256sum | cut -d ' ' -f 1)
RELEASE="$DATA/releases/$HASH"
mkdir -p "$DATA/releases"

if [ ! -f "$RELEASE/.ready" ]; then
  STAGE=$(mktemp -d "$DATA/releases/.prepare.XXXXXX")
  trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
  mkdir "$STAGE/runtime" "$STAGE/ui"
  tar -xzf "$SEED/runtime.tgz" -C "$STAGE/runtime"
  tar -xzf "$SEED/ui.tgz" -C "$STAGE/ui"
  echo 'Installing OCM runtime dependencies...'
  (
    cd "$STAGE/runtime"
    if [ -f package-lock.json ]; then
      npm ci --omit=dev --ignore-scripts --no-audit --no-fund
    else
      npm install --omit=dev --ignore-scripts --no-audit --no-fund
    fi
    node -e 'for (const p of ["bcryptjs","mongodb","nats","node-red-contrib-uibuilder","vue","qrcode"]) require.resolve(p)'
  )
  echo 'Building the OCM UI...'
  (
    cd "$STAGE/ui"
    if [ -f package-lock.json ]; then
      npm ci --include=dev --ignore-scripts --no-audit --no-fund
    else
      npm install --include=dev --ignore-scripts --no-audit --no-fund
    fi
    npm run build
  )
  test -s "$STAGE/runtime/uibuilder/orce/dist/index.html"
  test -s "$STAGE/runtime/uibuilder/orce/dist/.vite/manifest.json"
  test -s "$STAGE/runtime/flows.json"
  touch "$STAGE/runtime/.ready"
  mv "$STAGE/runtime" "$RELEASE"
  rm -rf "$STAGE"
  trap - EXIT HUP INT TERM
else
  echo 'Using the prepared OCM runtime.'
fi

# Publish only after installation and compilation have both completed.
ln -sfn "$RELEASE" "$DATA/current-new"
mv -Tf "$DATA/current-new" "$DATA/current"
for entry in node_modules lib uibuilder; do
  ln -sfn "current/$entry" "$DATA/$entry-new"
  mv -Tf "$DATA/$entry-new" "$DATA/$entry"
done
touch "$DATA/OCM-UI-V3-MANAGED"
cp "$RELEASE/flows.json" "$DATA/flows.json.new"
mv -f "$DATA/flows.json.new" "$DATA/flows.json"
cp "$RELEASE/package.json" "$DATA/package.json"
printf '%s\n' "module.exports = require('$DATA/current/settings.js');" > "$DATA/settings.js.new"
mv -f "$DATA/settings.js.new" "$DATA/settings.js"
touch "$DATA/OCM-UI-V3-MANAGED"
echo 'OCM runtime prepared.'
