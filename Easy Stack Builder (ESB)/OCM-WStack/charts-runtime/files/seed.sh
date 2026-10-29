#!/bin/sh
set -eu

DATA=${OCM_DATA_DIR:-/data}
SEED=${OCM_SEED_DIR:-/seed}
export npm_config_cache=${npm_config_cache:-/tmp/npm-cache}

# Never overwrite a separately managed Node-RED installation.
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
HASH=$({
    for file in flows.json index.html index.js index.css facis-logo.svg settings.js seed.sh; do
        sha256sum "$SEED/$file" | cut -d ' ' -f 1
    done
    printf '%s\n' "$RUNTIME" "${OCM_BASE_IMAGE:-}"
} | sha256sum | cut -d ' ' -f 1)
RELEASE="$DATA/releases/$HASH"
mkdir -p "$DATA/releases"

if [ ! -f "$RELEASE/.ready" ]; then
    STAGE=$(mktemp -d "$DATA/releases/.prepare.XXXXXX")
    trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
    mkdir -p "$STAGE/uibuilder/orce/src" "$STAGE/uibuilder/.config"
    cp "$SEED/flows.json" "$STAGE/flows.json"
    cp "$SEED/settings.js" "$STAGE/settings.js"
    for file in index.html index.js index.css facis-logo.svg; do
        cp "$SEED/$file" "$STAGE/uibuilder/orce/src/$file"
    done
    # Dependency metadata is generated in the target volume, not maintained as a second application.
    cat >"$STAGE/package.json" <<'JSON'
{"name":"ocm-orce-flows","version":"12.6.3","private":true,"dependencies":{"bcryptjs":"2.4.3","mongodb":"6.13.0","nats":"2.29.2","node-red-contrib-uibuilder":"7.5.0","vue":"3.5.13","qrcode":"1.5.4"}}
JSON
    # uibuilder loads this fixed integration hook; the actual authentication code lives in flows.json.
    cat >"$STAGE/uibuilder/.config/sioMiddleware.js" <<'JS'
module.exports = function(socket, next) {
    const path = require('node:path');
    const settings = require(path.join(process.env.OCM_DATA_DIR || '/data', 'current/settings.js'));
    const middleware = settings.functionGlobalContext.ocmBridge.socketMiddleware;
    if (!middleware) return next(new Error('AUTHENTICATION_REQUIRED'));
    middleware(socket, next);
};
JS
    (
        cd "$STAGE"
        npm install --omit=dev --ignore-scripts --no-audit --no-fund
        node -e 'for (const p of ["bcryptjs","mongodb","nats","node-red-contrib-uibuilder","vue","qrcode"]) require.resolve(p)'
        node -e 'const fs=require("node:fs"); const flows=JSON.parse(fs.readFileSync("flows.json")); if(!Array.isArray(flows)||!flows.some(n=>n.type==="uibuilder"))process.exit(1)'
        node --check settings.js
        node --check uibuilder/orce/src/index.js
        test -s node_modules/vue/dist/vue.runtime.esm-browser.prod.js
    )
    touch "$STAGE/.ready"
    mv "$STAGE" "$RELEASE"
    trap - EXIT HUP INT TERM
fi

# Publish the fully prepared release. Retain database volumes, Secrets and prior releases.
ln -sfn "$RELEASE" "$DATA/current-new"
mv -Tf "$DATA/current-new" "$DATA/current"
for entry in node_modules uibuilder; do
    ln -sfn "current/$entry" "$DATA/$entry-new"
    mv -Tf "$DATA/$entry-new" "$DATA/$entry"
done
cp "$RELEASE/flows.json" "$DATA/flows.json.new"
mv -f "$DATA/flows.json.new" "$DATA/flows.json"
cp "$RELEASE/package.json" "$DATA/package.json"
printf '%s\n' "module.exports = require('$DATA/current/settings.js');" >"$DATA/settings.js.new"
mv -f "$DATA/settings.js.new" "$DATA/settings.js"
touch "$DATA/OCM-UI-V3-MANAGED"
echo 'Node-RED flows and uibuilder files installed.'
