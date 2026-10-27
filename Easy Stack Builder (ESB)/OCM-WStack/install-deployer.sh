#!/usr/bin/env bash
# Install the standard deployment flow into a stopped, operator-selected Node-RED user directory.
set -Eeuo pipefail
umask 077

if [[ $# != 4 ]]; then
    printf 'Usage: %s USER_DIRECTORY FLOW_FILENAME CONFIG_FILE CREDENTIALS_FILE\n' "$0" >&2
    exit 2
fi
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
data=$(realpath -e -- "$1")
flows=$data/$2
config=$(realpath -e -- "$3")
credentials=$(realpath -e -- "$4")
[[ $2 != */* && -f $data/settings.js ]] || { printf 'Select a flow filename and a user directory with settings.js.\n' >&2; exit 1; }
[[ -f $flows && ! -L $flows ]] || { printf 'The selected flow file must exist and must not be a symlink.\n' >&2; exit 1; }
jq -e 'type=="array"' "$flows" >/dev/null
jq -e 'type=="object"' "$config" >/dev/null
jq -e 'type=="object"' "$credentials" >/dev/null
[[ $(stat -c '%a' "$credentials") == 600 ]] || { printf 'Set credential file permissions to 0600.\n' >&2; exit 1; }

stage=$(mktemp -d "$data/.ocm-flow-install.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT

# Refuse ID collisions with unrelated nodes. Reinstallation replaces only this tab and its nodes.
jq -e 'all(.[]; (.id!="ocm-deploy-action" or (.z=="ocm-deployer" and .type=="function")) and
    (.id!="ocm-deployer" or (.type=="tab" and .label=="OCM deployer")))' "$flows" >/dev/null
jq --arg root "$root" --arg config "$config" --arg credentials "$credentials" '
    map(if .type=="tab" then .env |= map(
        if .name=="OCM_DEPLOY_ROOT" then .value=$root
        elif .name=="OCM_DEPLOY_CONFIG_FILE" then .value=$config
        elif .name=="OCM_DEPLOY_CREDENTIALS_FILE" then .value=$credentials else . end)
    else . end)' "$root/deployer-flow.json" >"$stage/deployer.json"
jq --slurpfile imported "$stage/deployer.json" \
    'map(select(.id!="ocm-deployer" and .z!="ocm-deployer")) + $imported[0]' "$flows" >"$stage/flows.json"

cat >"$stage/settings.js" <<'JS'
// OCM deployment-flow integration. Existing Node-RED settings remain authoritative.
const settings = require('./settings.before-ocm-flow.js');
const path = require('node:path');
settings.functionGlobalContext = {
    ...settings.functionGlobalContext,
    ocmDeployerPlatform: {
        childProcess: require('node:child_process'), fs: require('node:fs'),
        fsPromises: require('node:fs/promises'), streamPromises: require('node:stream/promises'),
        os: require('node:os'), path, readline: require('node:readline'),
        timers: require('node:timers'), process, AbortController,
        userDir: settings.userDir || __dirname
    }
};
module.exports = settings;
JS
node --check "$stage/settings.js"
if [[ -e $data/settings.before-ocm-flow.js ]]; then
    cmp -s "$stage/settings.js" "$data/settings.js" || {
        printf 'Settings changed after the previous installation; merge the integration manually.\n' >&2; exit 1;
    }
else
    cp -p -- "$data/settings.js" "$data/settings.before-ocm-flow.js"
fi
backup=$flows.before-ocm-flow
[[ -e $backup ]] || cp -p -- "$flows" "$backup"
mv -f -- "$stage/settings.js" "$data/settings.js"
mv -f -- "$stage/flows.json" "$flows"
printf 'Installed OCM deployer flow. Restart Node-RED using %s/settings.js.\n' "$data"
printf 'Existing custom OCM-W-Stack palette nodes are retained; migrate their wires to the new Function node before removing them.\n'
