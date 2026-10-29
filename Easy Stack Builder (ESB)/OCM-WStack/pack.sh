#!/usr/bin/env bash
# Build the palette-installable archive outside the source tree.
set -Eeuo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
destination=${1:?Usage: bash pack.sh OUTPUT_DIRECTORY}
mkdir -p -- "$destination"
destination=$(cd -- "$destination" && pwd -P)
case "$destination/" in
    "$root/"*) echo 'Choose an output directory outside OCM-WStack.' >&2; exit 1 ;;
esac

cd -- "$root"
npm pack --ignore-scripts --pack-destination "$destination"
