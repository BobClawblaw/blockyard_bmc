#!/usr/bin/env node
// Writes BlockYard's local.json for the monitor container, from the environment, every start.
//
// BlockYard reads a node's credentials from a config FILE only -- there is no
// BLOCKYARD_RPC_USER and no BLOCKYARD_RPC_PASSWORD (server/config.js) -- so something has to
// write one, and env is all a container gets. This is the same pattern as BlockYard's own
// Umbrel entrypoint, for the same reason, and it deliberately does NOT touch blockyard.json
// beside it (the Display settings people choose in the UI) or state/ (accounts, sessions,
// history): those are the app's own and last as long as the volume does.
import fs from 'node:fs';
import path from 'node:path';

/** The node's datadir, mounted READ-ONLY in this container. */
export const BMC_MOUNT = '/bmc';

/**
 * The local.json object for this environment.
 *
 * Three things here are specific to this being a bmc node rather than Bitcoin Core, and each
 * is a thing the Core image cannot do:
 *
 *  - `logFile` is set, and the log source is on (blockyard.sh's env). BlockYard's log parsers
 *    were written against bmc's grammar; against a Core debug.log every line falls through as
 *    an unstructured event timestamped at read time. This is the one deployment where
 *    following the node's log is correct rather than harmful.
 *  - there is NO `addressIndex`. bmc serves address history itself (addrindex=1), and
 *    BlockYard skips building its own when the node reports that capability -- no second
 *    124 GB index and no half-hour build.
 *  - `datadir` is the PARENT of the chain directory, as bmc lays it out: <datadir>/<chain>/.
 */
export function renderConfig(env = process.env) {
  const chain = env.BMC_CHAIN || 'main';
  const chainDir = path.join(BMC_MOUNT, chain);
  const host = env.BMC_RPC_HOST || 'bmc';
  const port = env.BMC_RPC_PORT || '8332';
  return {
    _comment: [
      'Written by entrypoint/render-blockyard-config.mjs on every container start, from the',
      'environment. Editing it inside the container is pointless: the next start overwrites',
      'it. Display settings are NOT here -- they live beside this file in blockyard.json,',
      'which this entrypoint never touches.',
    ],
    server: { host: '0.0.0.0', port: Number(env.BLOCKYARD_PORT || 21000) },
    nodes: [
      {
        id: 'bmc',
        label: env.BMC_LABEL || (chain === 'main' ? 'Bitcoin Machine Code' : `Bitcoin Machine Code (${chain})`),
        rpcUrl: `http://${host}:${port}`,
        // Cookie auth over the shared volume: bmc writes <datadir>/<chain>/.cookie at start-up
        // (mode 0600, always) and deletes it at shutdown, so both containers run as the same
        // uid and the monitor simply reads the file. Nothing carries an RPC password.
        cookieFile: path.join(chainDir, '.cookie'),
        datadir: BMC_MOUNT,
        chainHint: chain,
        logFile: path.join(chainDir, 'debug.log'),
        logStaleMs: 600_000,
        color: '#3d8bff',
        // The node may be down, restarting, or minutes from answering RPC while it reloads its
        // archive. `optional` is what keeps the monitor up and honest about that instead of
        // refusing to boot beside a node that is still coming up.
        optional: true,
      },
      ...coreNode(env),
    ],
  };
}

/**
 * The A/B node: an EXISTING Bitcoin Core, watched beside bmc in the same monitor.
 *
 * Operator, 2026-09-24, on why this package defaults to mainnet: "I want people to be able to
 * A/B this against Core mainnet if they want to." That comparison needs both nodes on one
 * page, and BlockYard is already multi-node -- so the only thing missing was a way to name a
 * Core node from the environment. Unset CORE_RPC_URL and nothing is added.
 *
 * It points at a Core somebody ALREADY RUNS rather than shipping one: a second node in this
 * compose file would double the disk to ~2.4 TB, and packaging Core is not this project's job.
 *
 * Three things here are deliberately different from the bmc entry above:
 *
 *  - `logFile: null`. BlockYard's parsers do not understand Core's log grammar; pointed at a
 *    Core debug.log every line falls through unstructured and timestamped at read time. The
 *    container's BLOCKYARD_LOG_SOURCE=1 is safe because the log source is decided PER NODE by
 *    whether it has a logFile, and this one does not.
 *  - no `addressIndex`, ever. Core has no address index of its own, so naming one here would
 *    start BlockYard building a ~124 GB copy from Core's block files -- which is a reasonable
 *    thing to want and a very unreasonable thing to start by surprise. Someone who wants it
 *    can add it to the rendered config's node entry themselves.
 *  - credentials come from the environment: a cookie file if Core's datadir is mounted into
 *    this container, otherwise rpcuser/rpcpassword.
 */
export function coreNode(env = process.env) {
  const url = (env.CORE_RPC_URL || '').trim();
  if (!url) return [];
  const chain = env.CORE_CHAIN || env.BMC_CHAIN || 'main';
  const node = {
    id: 'core',
    label: env.CORE_LABEL || 'Bitcoin Core',
    rpcUrl: url,
    chainHint: chain,
    // Core's log is never parsed -- see above. Explicit, not omitted, so the intent is legible
    // in the rendered file.
    logFile: null,
    color: '#f7931a',
    optional: true,
  };
  if (env.CORE_COOKIE_FILE) node.cookieFile = env.CORE_COOKIE_FILE;
  if (env.CORE_DATADIR) node.datadir = env.CORE_DATADIR;
  if (env.CORE_RPC_USER) node.rpcUser = env.CORE_RPC_USER;
  if (env.CORE_RPC_PASSWORD) node.rpcPassword = env.CORE_RPC_PASSWORD;
  if (!node.cookieFile && !node.datadir && !node.rpcUser) {
    throw new Error('CORE_RPC_URL is set but no credential is: give CORE_COOKIE_FILE (with Core\'s '
      + 'datadir mounted into this container), or CORE_DATADIR, or CORE_RPC_USER and CORE_RPC_PASSWORD');
  }
  return [node];
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  const out = process.env.BLOCKYARD_CONFIG || '/data/blockyard/local.json';
  const cfg = renderConfig();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  const node = cfg.nodes[0];
  console.log(`blockyard: wrote ${out} for ${node.rpcUrl} (${node.chainHint})`);
  if (!fs.existsSync(node.cookieFile)) {
    // Not fatal: the node takes a couple of minutes to write it, and `optional` means the
    // monitor waits rather than failing. Saying so up front is the difference between a
    // patient start and a bug report.
    console.log(`blockyard: ${node.cookieFile} is not there yet -- normal while the node boots; `
      + 'the monitor will show it offline until it appears');
  }
}
