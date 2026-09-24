#!/usr/bin/env node
// Writes <datadir>/bitcoin.conf for the node container, from the environment, on every start.
//
// bmc reads <datadir>/bitcoin.conf, then <datadir>/../config/bitcoin.conf, then $BITCOIN_CONF.
// A daemon that finds none logs `[config] no config file at ... -- using compiled defaults`
// and runs on them: P2P 8333, RPC on LOOPBACK. In a container, loopback RPC means the monitor
// in the next container cannot reach it at all, so this file is not optional dressing.
import fs from 'node:fs';
import path from 'node:path';

/** bmc's chain names, which are also its datadir subdirectory names. */
export const CHAINS = Object.freeze(['main', 'testnet4', 'signet', 'regtest']);

/** The `key=1` a chain other than mainnet needs; mainnet is the default and names nothing. */
const CHAIN_SWITCH = Object.freeze({ testnet4: 'testnet4', signet: 'signet', regtest: 'regtest' });

const bool = (v, dflt) => (v === undefined || v === '' ? dflt : !/^(0|false|no|off)$/i.test(v));
const num = (v, dflt) => (v === undefined || v === '' ? dflt : Number(v));

/**
 * The bitcoin.conf text for this environment.
 *
 * Throws rather than writing something that would leave the node unreachable: an unknown
 * chain, or an RPC bound to an address with nothing allowed to reach it.
 */
export function renderConf(env = process.env) {
  const chain = env.BMC_CHAIN || 'main';
  if (!CHAINS.includes(chain)) {
    throw new Error(`BMC_CHAIN="${chain}" is not one of ${CHAINS.join(', ')} (bmc has no testnet3)`);
  }
  const rpcBind = env.BMC_RPC_BIND || '0.0.0.0';
  const allow = (env.BMC_RPC_ALLOW_IP || '').split(',').map((s) => s.trim()).filter(Boolean);
  // THE PAIR IS THE POINT. bmc's own reference config: "The listener binds loopback unless
  // rpcbind names an IPv4 address AND at least one rpcallowip is given; rpcbind without
  // rpcallowip is ignored with a warning." Ignored, not refused -- so getting this wrong
  // produces a node that starts, logs, syncs, and is simply never reachable by the monitor.
  if (rpcBind !== '127.0.0.1' && !allow.length) {
    throw new Error('BMC_RPC_ALLOW_IP is empty while BMC_RPC_BIND is not loopback: bmc would ignore '
      + 'rpcbind and listen on 127.0.0.1 only, and the monitor could never reach it. Set it to the '
      + "compose network's subnet (docker-compose.yml fixes that subnet so this can be exact).");
  }

  const lines = [
    '# Written by entrypoint/render-bmc-conf.mjs on every container start, from the',
    '# environment. Editing it inside the container is pointless: the next start overwrites it.',
    '# Change docker-compose.yml or .env instead.',
    '',
  ];
  const set = (k, v) => lines.push(`${k}=${v}`);

  // The chain switch is global and must come before the section header.
  if (CHAIN_SWITCH[chain]) set(CHAIN_SWITCH[chain], 1);

  // THE LOG IS THE FILE, AND THE CONSOLE IS AN ADDITION. bmc's reference config, since
  // 2026-09-08: "the log is <chaindir>/debug.log (debuglogfile), as Core; printtoconsole=1
  // adds the console". Both carry the same lines, which is what lets `docker logs` show the
  // node while the monitor's follower reads the same events out of the file.
  set('printtoconsole', 1);
  set('dbcache', num(env.BMC_DBCACHE, 1024));
  set('maxconnections', num(env.BMC_MAXCONNECTIONS, 48));
  lines.push('');

  // RPC BEFORE THE DOWNLOAD, WHICH IS THE WHOLE POINT OF THIS PACKAGE, AND NOT bmc's DEFAULT.
  //
  // Measured on mainnet from an empty datadir, 2026-09-24. With bmc's default
  // (bmc.bootcatchup=1) the parallel block download runs INSIDE the boot phase, and
  // serve_start_rpc() is only reached once that finishes (asm/daemon/main.c:11857, after
  // "[boot] boot phase complete"). So for the whole of a first sync -- eighteen hours and more
  // -- the node writes no cookie, binds no RPC port, and a monitor beside it correctly reports
  // it unreachable while it is demonstrably working. The node says so itself at boot:
  //
  //   [boot] boot catch-up runs BEFORE the UTXO engine starts: its blocks are connected by the
  //          worker afterwards (bmc.bootcatchup=0 leaves the download to the worker, which
  //          connects while it downloads)
  //
  // With it off, the same empty datadir reached "[boot] boot phase complete (0.07s total)" and
  // "[rpc] block archive opened (chain RPCs live)" in the same second, and the monitor read the
  // node as online from the first poll. A >=2000-block gap still triggers the parallel
  // downloader later; what changes is that it no longer runs before anything can be watched.
  //
  // BMC_BOOT_CATCHUP=1 restores bmc's default. Use it for a TIMED run: every published sync
  // figure for this node was measured that way, and this setting changes the strategy, so a
  // sync run with it off is not comparable to them. See docs/DESIGN.md, "Watching the sync".
  lines.push('# rpc is up before the download, so the sync can be watched (docs/DESIGN.md)');
  set('bmc.bootcatchup', bool(env.BMC_BOOT_CATCHUP, false) ? 1 : 0);
  lines.push('');

  // A RESTART MID-SYNC MUST NOT WEDGE THE NODE (bitcoinmachinecode#294, hit here 2026-09-24).
  //
  // bmc sizes its UTXO memtable from the block gap at boot: below bmc.utxobulkgapblocks
  // (default 50,000) it takes the steady-state table, 2^16 slots and a 64 MB blob. Restart a
  // node part-way through a sync and the gap is small -- mine was 3,345 -- but the LSM store is
  // still bulk-shaped, 17 runs and 42 GB here, so every lookup probes up to 17 runs through a
  // 64 MB cache. Measured: ~100% CPU, ZERO blocks applied in 25 minutes, no peers (the worker
  // closes the gap before it dials), and no log line after the sizing decision. It reads as a
  // hang, and it does not recover by itself.
  //
  // 500 is low enough that any restart during a sync takes the bulk table, and high enough
  // that a node following the tip does not: 500 blocks is about three and a half days, so
  // ordinary tip operation stays on the small table where it belongs. With it set, the same
  // datadir loaded its UTXO state in 162 s and resumed at 11 blk/s.
  //
  // bmc's own code argues for erring this way -- "bulk sizing costs address space, not resident
  // memory, so over-selecting it is cheap and under-selecting it is what wedges a restart".
  //
  // This is a WORKAROUND for a sizing heuristic that consults the block gap and the WAL but not
  // the store's run count. If #294 lands a run-count trigger, this becomes redundant rather
  // than wrong, and can go back to bmc's default by setting BMC_UTXO_BULK_GAP=50000.
  lines.push('# a restart mid-sync takes the bulk memtable, not the steady-state one (#294)');
  set('bmc.utxobulkgapblocks', num(env.BMC_UTXO_BULK_GAP, 500));
  lines.push('');

  // The indexes, which are most of the disk. addrindex is the one that changes what the
  // MONITOR has to do: with it on, the node serves address history and BlockYard does not
  // build and follow a second copy of it (~124 GB and half an hour on a fast machine).
  lines.push('# indexes -- see docs/DESIGN.md, "What this costs on disk"');
  set('addrindex', bool(env.BMC_ADDRINDEX, true) ? 1 : 0);
  set('txindex', bool(env.BMC_TXINDEX, true) ? 1 : 0);
  set('coinstatsindex', bool(env.BMC_COINSTATSINDEX, true) ? 1 : 0);
  set('blockfilterindex', bool(env.BMC_BLOCKFILTERINDEX, false) ? 1 : 0);
  lines.push('');

  if (env.BMC_EXTRA_CONF) {
    // Verbatim, and BEFORE the section header so it lands in the global scope. A
    // network-specific setting passed this way has to carry its own [section].
    //
    // SPLIT ON A LITERAL BACKSLASH-n AS WELL AS A REAL NEWLINE. A .env file cannot carry a
    // real newline inside a value, so `BMC_EXTRA_CONF=a=1\nb=2` -- which is how .env.example
    // documents it, and the only way anyone can write it there -- arrives as the two
    // characters `\` and `n`. Splitting on real newlines alone turned the whole thing into one
    // unparseable line, silently: the daemon logs the bad key and carries on with its default,
    // so the setting simply does not happen. Found 2026-09-24 while setting two of them.
    lines.push('# BMC_EXTRA_CONF, verbatim');
    lines.push(...env.BMC_EXTRA_CONF.split(/\\n|\n/).map((s) => s.trim()).filter(Boolean));
    lines.push('');
  }

  // NETWORK-SPECIFIC SETTINGS GO UNDER A SECTION HEADER, ALWAYS, AND THAT IS NOT COSMETIC.
  // Measured 2026-09-24 on regtest, with these four written at the top level, the node said:
  //
  //   [config] rpcbind= is network-specific and appears outside any section while
  //            chain=regtest: ignoring it (Core does the same; put it under [regtest] to apply it)
  //
  // Ignored, and the node started anyway -- listening on loopback, so the monitor in the next
  // container never reached it and reported it offline. Top-level keys DO apply on mainnet
  // (Core's rule, which bmc follows), so writing the section unconditionally is what makes the
  // behaviour identical on every chain instead of correct on one of them.
  lines.push(`[${chain}]`);
  set('port', num(env.BMC_P2P_PORT, 8333));
  set('rpcport', num(env.BMC_RPC_PORT, 8332));
  set('rpcbind', rpcBind);
  for (const cidr of allow) set('rpcallowip', cidr);
  lines.push('');

  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  const datadir = process.env.BMC_DATADIR || '/data/bmc';
  let text;
  try {
    text = renderConf();
  } catch (err) {
    console.error(`bmc: refusing to start -- ${err.message}`);
    process.exit(1);
  }
  fs.mkdirSync(datadir, { recursive: true });
  const out = path.join(datadir, 'bitcoin.conf');
  fs.writeFileSync(out, text, { mode: 0o600 });
  const chain = process.env.BMC_CHAIN || 'main';
  console.log(`bmc: wrote ${out} (chain ${chain}, rpc ${process.env.BMC_RPC_BIND || '0.0.0.0'}:${process.env.BMC_RPC_PORT || 8332})`);
  console.log(`bmc: datadir ${datadir}; the monitor reads ${path.join(datadir, chain, '.cookie')} and ${path.join(datadir, chain, 'debug.log')}`);
}
