#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec node "$root/installer/install.mjs" --uninstall "$@"
