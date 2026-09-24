#!/bin/sh
# The node container.
#
# Two steps, and the second is an `exec` ON PURPOSE. bmc honours SIGTERM and needs the time
# to flush its UTXO set (README: "give shutdown time for a UTXO flush"; the compose file
# allows 300 s). A shell or a Node process sitting between PID 1 and the daemon would have to
# forward that signal correctly or a `docker stop` would look like a crash and cost a long
# recovery on the next boot. Exec means the daemon IS PID 1 and Docker signals it directly.
set -e

# The config is rendered on EVERY start, from the environment -- same reasoning as BlockYard's
# own Umbrel entrypoint: a derived file written once goes stale the moment the compose file
# changes, and a stale bitcoin.conf aims the node at the wrong port or leaves its RPC
# unreachable, which reads as a credentials fault three layers away.
node /app/entrypoint/render-bmc-conf.mjs

# BMC_SERVE_ARGS is unquoted deliberately: `serve <datadir> [port] [nwant] [workers]` takes
# positional arguments, and this is how an operator passes them. Empty by default.
# shellcheck disable=SC2086
exec "${BMC_HOME:-/usr/local/lib/bmc}/bmcbitcoind" serve "${BMC_DATADIR:-/data/bmc}" ${BMC_SERVE_ARGS}
