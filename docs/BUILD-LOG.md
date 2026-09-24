# Building and proving it, 2026-09-24

What was measured while this package was written, including the four things that were wrong
before they were measured. Every figure here comes from this box: AMD Ryzen 9 9950X3D, Docker
29.1.3, no `buildx`.

## The image

```
blockyard-bmc:dev   452 MB total, of which 336 MB is the shared node:22-trixie-slim base
                    115.9 MB unique to this image, 20 layers
```

What occupies the unique part:

| | |
|---|---|
| `/usr/local/lib/bmc` (daemon + 5 helpers + cli) | 33 MB |
| `/app/games` (the DOS Diversions; `--build-arg WITH_GAMES=0` drops them) | 26 MB |
| `/app/docs` (BlockYard's documentation, as its own image ships it) | 22 MB |
| `/app/public` + `/app/server` | 3.5 MB |

## Four things that were wrong, and how each announced itself

These are in the order they were hit. Each one is now a comment at the place it bit, because
each would otherwise be rediscovered by whoever changes that line next.

### 1. `git fetch` cannot take an abbreviated sha

```
fatal: couldn't find remote ref fbb22e23
```

`git fetch` resolves a ref name or a whole object id, and a short sha is neither. Both pins are
full 40-character shas now, and the `ARG` says so.

### 2. bmc's `-Werror` build is pinned to gcc 13

The decisive experiment, same commit, same `make daemon/bmcbitcoind`, three bases:

| builder | gcc | result |
|---|---|---|
| `debian:bookworm-slim` | 12.2.0 | **fails** — `-Werror=format-truncation`, `daemon/main.c:8564` and `:8586` |
| `ubuntu:24.04` | 13.3.0 | **builds** — the toolchain bmc is developed and tested on |
| `debian:trixie-slim` | 14.2.0 | **fails** — `-Werror=format-truncation`, `rpc_node.c:3390` and `miniscript.c` |

Neither neighbour of gcc 13 will do, and they fail at *different* sites, so this is compilers
analysing differently rather than a bug moving around. bmc's Makefile treats every warning as
an error deliberately ("every nasm warning is a build failure"), which is a good rule that also
means the build is only reproducible on the compiler it was written against.

The knock-on: `ubuntu:24.04` has glibc 2.39, so the runtime must be 2.39 or newer. `node:22-slim`
is bookworm (2.36) and would not run the binary at all; the runtime is `node:22-trixie-slim`
(2.41). Forwards is the direction glibc guarantees.

**If either pin is ever moved, repeat the experiment.** Do not assume a newer base works.

### 3. A named volume's mount point must exist in the image

```
Error: EACCES ... syscall: 'open', path: '/data/bmc/bitcoin.conf'
```

A named volume takes its initial ownership from the image's directory at that path. The
Dockerfile created and chowned `/data`, but the volumes mount at `/data/bmc` and
`/data/blockyard` — paths the image did not have — so Docker created them owned by **root**,
and a container running as uid 1000 could not write into its own volume. Both nested paths are
created and chowned now.

### 4. Network-specific settings are ignored outside a `[chain]` section

The best failure of the four, because the node said exactly what was wrong and carried on:

```
[config] rpcbind= is network-specific and appears outside any section while chain=regtest:
         ignoring it (Core does the same; put it under [regtest] to apply it)
```

`port`, `rpcport`, `rpcbind` and `rpcallowip` are network-specific. Written at the top level
they apply on **mainnet** and are ignored everywhere else — so the node started, logged, and
listened on loopback, and the monitor beside it reported it offline for a reason that looked
like a credentials problem. The renderer now writes those four under `[<chain>]`
unconditionally, which makes the behaviour identical on every chain rather than correct on one.

Anything passed through `BMC_EXTRA_CONF` lands in the global scope and has to carry its own
section if it is network-specific.

## What the smoke test proves

`scripts/smoke.sh`, on regtest, 17 checks, all passing 2026-09-24:

```
== the image ==
  ok   blockyard-bmc:dev exists (110 MB)
  ok   the administrative suite is absent
  ok   the daemon and all five index helpers are present, beside each other
  ok   without CORE_RPC_URL the monitor watches bmc alone
  ok   CORE_RPC_URL adds a Core node beside bmc, for A/B on the same page
  ok   a Core node with no credential is refused at start-up, not left unauthenticated
== the node ==
  ok   started
  ok   wrote its RPC cookie (the config rendered, and the RPC listener bound)
  ok   the rendered bitcoin.conf carries the rpcbind/rpcallowip pair and printtoconsole
  ok   answers RPC on the loopback inside its container
== the monitor ==
  ok   started
  ok   serves /api/health
  ok   rendered a config that uses the node's cookie and does NOT build a second address index
  ok   reached the node over the compose network and read back chain=regtest, so the shared
       cookie authenticated
  ok   a syncing bmc node is hidden from the picker, as BlockYard intends, and stays the primary
  ok   the log follower is reading the node's debug.log (68 lines, parse ratio 0.9118)
== shutdown ==
  ok   the node exited 0 on SIGTERM, so the signal reached the daemon and not a shell
```

Two of those are worth reading twice.

**The log follower works on `debug.log`.** This was the design's biggest unverified assumption:
the production monitor follows the *console* log file that systemd writes, and this package
points it at the file sink instead, on the strength of bmc's own reference config saying the
two carry the same lines. They do — 68 lines read at a **0.9118 parse ratio**, which is above
the 0.85 floor BlockYard's own frozen-sample test holds its parsers to.

**The node exits 0 on SIGTERM.** The entrypoint `exec`s the daemon, so it is PID 1 and Docker
signals it directly. A shell or a Node process in between would have to forward that signal
correctly, and a SIGTERM that does not arrive promptly is a UTXO flush that does not happen.

## A behaviour that is not a bug, and matters to this package

`/api/nodes` returns an **empty list** while the bmc node is syncing. That is deliberate in
BlockYard (`server/http/api.js`: "only show 100% synced BMC nodes in the drop-down", operator,
2026-09-19), written when every bmc node was a benchmark run sitting beside a synced Core node.

In this package the bmc node is the only node and will be syncing for a day or more, so the
picker is empty for that whole time. The page still works — `primary` remains `bmc`,
`/api/state?node=bmc` answers in full, and the sync hero shows the progress, which is the thing
people open this package to watch. But the drop-down is blank, and that will read as a fault to
someone who does not know the rule.

Worth a decision before any release: leave it (the picker is a single unchanging label with one
node anyway), or make that filter conditional on there being another node to switch to.

## What is still unverified

Stated plainly, because none of it can be inferred from the above:

- **a mainnet sync in this image.** Everything here is regtest, which reaches a working state in
  seconds and exercises no I/O. The disk and duration figures in `docs/DESIGN.md` come from the
  bare-metal production and benchmark nodes.
- **`docker compose up` as a whole.** The compose file is validated (`docker compose config`
  parses and resolves both services, the fixed subnet and the 5-minute stop grace), and the
  smoke test runs the same two containers by hand with the same wiring — but a real `up` on
  mainnet starts a 1.2 TB sync, which is not something to trigger to tick a box.
- **restart and upgrade mid-sync**, and whether a container stop resumes as cleanly as
  `systemctl stop` does.
- **anything on arm64**, which cannot be tested because it cannot be built.
