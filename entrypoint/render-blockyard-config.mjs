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
    ],
  };
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
