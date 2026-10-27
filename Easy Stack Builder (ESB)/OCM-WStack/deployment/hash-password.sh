#!/usr/bin/env bash
# Use the existing bcrypt algorithm and cost; passwords arrive only on stdin.
set -Eeuo pipefail

if node -e 'if(require("bcryptjs/package.json").version!=="2.4.3")process.exit(1)' </dev/null >/dev/null 2>&1; then
    library=bcryptjs
else
    cache=${XDG_CACHE_HOME:-${HOME:?}/.cache}/ocm-wstack/bcrypt-2.4.3
    if [[ ! -f $cache/node_modules/bcryptjs/package.json ]]; then
        mkdir -p "$cache"
        npm install --prefix "$cache" --ignore-scripts --no-audit --no-fund \
            --save-exact bcryptjs@2.4.3 </dev/null >&2
    fi
    library=$cache/node_modules/bcryptjs
fi

node -e '
    (async () => {
        let password = "";
        for await (const chunk of process.stdin) {
            password += chunk;
            if (Buffer.byteLength(password) > 72) throw Error("Password exceeds 72 UTF-8 bytes.");
        }
        if ([...password].length < 12 || /[\x00-\x1f\x7f]/.test(password)) {
            throw Error("Password requires at least 12 characters without control characters.");
        }
        process.stdout.write(await require(process.argv[1]).hash(password, 12));
    })().catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
' "$library"
