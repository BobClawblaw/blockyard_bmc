#!/bin/sh
# The monitor container. Same shape as the node's: render, then exec.
#
# The exec matters less here than it does for the node -- BlockYard's shutdown saves a history
# snapshot, not a chain-scale UTXO set -- but there is no reason to put a shell between Docker
# and the process either.
set -e

node /app/entrypoint/render-blockyard-config.mjs

# server/main.js boots only when it decides it is being run directly, by comparing argv[1]
# against its own path (bin/blockyard.js and BlockYard's Umbrel entrypoint both splice argv
# for the same reason). Naming it as argv[1] here is what starts it.
exec node /app/server/main.js
