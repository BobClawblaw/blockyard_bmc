# Shipping bmc and BlockYard as one Docker package

2026-09-24. A proposal, with the things that block it first, because two of them are not
engineering problems and one of them cannot be fixed by anyone but the operator.

## What is being proposed

A node and the window into it, as one release: a Bitcoin Machine Code daemon and a BlockYard
monitor already configured to talk to each other, so that `docker compose up -d` gives a
syncing node **and** a browser page that shows the sync, the mempool, the block space and the
peers, with no config written by hand.

The pairing is not arbitrary. BlockYard's log parsers were written against bmc's log grammar
and understand nothing of Bitcoin Core's; bmc serves its own address index, which is the one
thing BlockYard otherwise has to build for itself over half an hour and 124 GB. Each is the
other's best case. The Umbrel package BlockYard already ships is the Core pairing, and it has
to turn both of those features off.

## Blockers, before any of the shape matters

### 1. bmc has no licence, so the image cannot be published

`github.com/BobClawblaw/bitcoinmachinecode` is public with **no `LICENSE` file** and GitHub
reports `licenseInfo: null` (checked 2026-09-24). Public is not permissive: with no licence
granted, the default position is that nobody may redistribute it. A Docker image containing
`bmcbitcoind` **is** redistribution, and pushing it to a public registry is publishing it.

BlockYard is Apache-2.0 and fine. The image is blocked on bmc alone, and the operator owns
that copyright, so the fix is a decision rather than a negotiation: pick a licence, add the
file, and the rest of this document is buildable. Worth deciding at the same time: the
NOTICE-style question of how an AI-authored tree states authorship and copyright, which the
project's own README already addresses in prose but not in a licence file.

**Until that file exists, build this image locally and do not push it.**

### 2. bmc's own description says "do not run this"

The repository's GitHub description ends "Unaudited — do not run this", and the README's status
box says to run it "for study and evaluation, on a machine you can afford to lose, with no
funds near it". A Docker package is the single most effective way ever invented to get software
running on machines whose owners did not read the status box.

That tension is a decision to take deliberately, not to route around. Three options, none of
them wrong:

- **Ship it anyway, with the warning carried in the image**: the compose file's first comment,
  the README's first paragraph, and a start-up banner in the node container's log. The operator
  is publishing an experimental node; users who reach for a Docker image are not less capable
  of reading than users who reach for `make`.
- **Default the package to a test chain.** `BMC_CHAIN=signet` or `testnet4` as the shipped
  default costs an experienced user one line in `.env` and stops an unattended `docker compose
  up` from becoming a mainnet node on somebody's laptop. It also makes the package usable on
  an ordinary disk, which mainnet is not (see below).
- **Do not publish at all**; keep the compose file in the repository as the documented way to
  run it, and let people build it themselves. This is the smallest step and loses very little:
  the build is 12 seconds of assembly plus a `git clone`.

My suggestion is the second plus the first: ship, default to a test chain, carry the warning
where it cannot be missed. Mainnet is one line away for anyone who means it.

### 3. linux/amd64 only

bmc is hand-written NASM ELF64 for the System V ABI. There is no arm64 build: the `arm-port`
branch was halted 2026-09-08 with its state written down for a later round, and the fourteen
`port/*` branches that fed it are ancestors of it. An Apple Silicon Mac, a Raspberry Pi and
most cheap VPS instances therefore cannot run this image at all, and Umbrel's own hardware is
mixed. The compose file states `platform: linux/amd64` so this fails at build with a clear
message rather than at run with an exec-format error.

This also rules out the multi-arch manifest BlockYard's own image publishes today.

## The shape: one image, two containers

Three shapes were considered.

| | one image, one container, supervisor | **one image, two containers** | two images, two containers |
|---|---|---|---|
| artifacts to build, publish, pin | 1 | **1** | 2 |
| node and monitor can be a release apart | no | **no** | yes, and will be |
| restart the monitor without bouncing the node | no | **yes** | yes |
| separate logs, health checks, stop timeouts | no | **yes** | yes |
| one process per container | no | **yes** | yes |
| wasted bytes | none | **~31 MB binary in the monitor, ~40 MB of JS in the node** | none |

The middle column wins on the two things that actually cost something here. A single artifact
means the node and its monitor are pinned together by construction — there is no version skew
to reason about, one digest in a compose file describes the whole deployment. Two containers
mean the node gets a 300-second stop timeout for its UTXO flush while the monitor gets a
5-second one, the node's log is the node's log, and restarting the monitor after a settings
change does not interrupt a sync that has been running for a day.

The wasted bytes are the argument against, and they are ~70 MB beside a datadir of 1.2 TB.

A supervisor in one container (the first column) is the shape people reach for when they want
`docker run` to be the whole story. It costs the ability to restart, watch or stop either half
independently, and it makes PID 1 a process that is not the daemon — which matters here more
than usual, because a SIGTERM that does not reach bmc promptly is a UTXO flush that does not
happen and a long recovery on the next boot.

## How they are wired

Five decisions, each of which is a way to get it wrong:

**The RPC cookie travels on the shared volume, and both containers run as uid 1000.** bmc
writes `<datadir>/<chain>/.cookie` at start-up and deletes it at shutdown, mode 0600, always
(`rpccookieperms` is one of the Core options it accepts without effect). The monitor mounts
the node's datadir read-only and reads that file. Nothing carries an RPC password, and no
credential is in the compose file or the environment. The two containers must therefore agree
on the uid — if they do not, the monitor sees a file it cannot open and reports the node as
unreachable, which looks exactly like the node being down.

**The compose network has a fixed subnet, so `rpcallowip` can be exact.** bmc binds its RPC to
loopback *unless* `rpcbind` names an address **and** at least one `rpcallowip` is given —
"rpcbind without rpcallowip is ignored with a warning", per its own reference config. Ignored,
not refused: get this wrong and the node starts, logs, syncs, and is simply never reachable.
Left to Docker, the bridge subnet is whatever is free that day, and the only `rpcallowip` that
would reliably work is a `172.16.0.0/12` that admits every bridge on the host. Fixing the
subnet in `docker-compose.yml` lets the node admit exactly one /24 and nothing else.

**The log is a file and the console is an addition.** Since 2026-09-08 bmc's log sink is
`<chaindir>/debug.log` and `printtoconsole=1` *adds* the console, both carrying the same lines.
So the node container sets `printtoconsole=1` — `docker logs` works — and the monitor follows
`debug.log` off the shared volume. `BLOCKYARD_LOG_SOURCE=1`, which is the opposite of what
BlockYard's Core image ships, and correct here for the reason the Core image is correct there.

**No `addressIndex` in the monitor's config.** bmc reports `addrindex` through
`bmcgetcapabilities` and BlockYard, seeing that, does not build its own. Leaving the key out is
what expresses that; setting it would start a 124 GB second copy of something the node already
serves.

**Both configs are rendered from the environment on every start, and neither is editable.** A
derived file written once goes stale the moment the compose file changes, and a stale
`bitcoin.conf` aims the node at the wrong port — a failure that surfaces three layers away as a
credentials problem. This is the pattern BlockYard's Umbrel entrypoint already uses, for the
same reason. What is *not* rendered: `blockyard.json` (the Display settings people choose in
the UI) and `state/` (accounts, sessions, history), which belong to the app and last as long as
the volume.

## What this costs on disk

Measured on the production node, 2026-09-24, mainnet with the shipped index set:

| | |
|---|---|
| the chain itself (`blk*.dat` + undo) | ~950 GB |
| address index + history (`addr_hist`, `addr_index`, tail) | ~240 GB |
| `txindex` | ~26 GB |
| `coinstatsindex` | ~2 GB |
| `blockfilterindex` (off by default; nothing in this package reads it) | ~13 GB |
| **total, as shipped** | **~1.2 TB** |

The first sync was measured at **18 h 29 m** on 2026-09-22 (16-core, NVMe, 8 download workers,
`dbcache=8192`) — and that was the benchmark configuration, unpolled and undisturbed. A slower
disk makes it a multi-day job. `.env.example` says this at the top because a package that
silently starts filling a terabyte is a package that gets uninstalled angrily.

This is the strongest argument for defaulting `BMC_CHAIN` to a test chain.

## Publishing, when the licence exists

BlockYard already has the machinery: `.github/workflows/publish-umbrel-image.yml` builds and
pushes to GHCR, and the compose file pins by digest as an app store requires. Two things carry
over and one does not:

- the **digest pin** pattern — `image: ghcr.io/…@sha256:…`, replaced after each publish
- the **lowercase-owner** fix in that workflow: `github.repository_owner` resolves to the
  real-cased account name and Docker rejects uppercase in a tag, which silently blocked every
  earlier attempt to publish that image until it was fixed on 2026-09-23
- the **multi-arch manifest** does not carry over: amd64 only, see above

An Umbrel submission would be a separate decision again — it would mean this package standing
beside the Core one in the same store, and Umbrel's fleet includes arm64 hardware that cannot
run it.

## One BlockYard behaviour that this package runs into

`/api/nodes` returns an **empty list** while a bmc node is syncing — deliberate, and the
operator's own instruction (2026-09-19, "only show 100% synced BMC nodes in the drop-down"),
written when every bmc node was a benchmark run sitting beside a synced Core node.

Here the bmc node is the only node, and it will be syncing for a day or more, so the picker is
blank for that whole time. Nothing breaks: `primary` stays `bmc`, `/api/state?node=bmc` answers
in full, and the sync hero shows the progress that people open this package to watch. But a
blank drop-down reads as a fault to anyone who does not know the rule.

A decision to take before release, not a bug to fix here: leave it (with one node the picker is
a single unchanging label anyway), or make that filter conditional on there being another node
to switch to.

## What is verified, and what is not

Built and run on this box, 2026-09-24. The full output, and the four bugs that only appeared
once it was actually built, are in [BUILD-LOG.md](BUILD-LOG.md).

Verified — `scripts/smoke.sh`, 14 checks, all passing on regtest:

- the image builds and is 452 MB (116 MB of it this package's own content)
- the administrative suite is absent, and the build **asserts** that rather than assuming it —
  `.dockerignore` cannot do this job when the sources arrive by `git clone`
- the daemon and all five index helpers land beside each other, which is what the daemon
  requires of them
- the node renders its config, boots, writes its cookie and answers RPC
- the monitor renders a config that uses that cookie and does **not** start a second address
  index, then **reads back `chain=regtest` from the node over the compose network** — which is
  the whole wiring proved in one assertion
- **the log follower reads the node's `debug.log` at a 0.9118 parse ratio**, above the 0.85
  floor BlockYard holds its own parsers to. This was the design's biggest assumption: the
  production monitor follows the *console* log that systemd writes, and this package points it
  at the file sink instead on the strength of bmc's reference config saying the two carry the
  same lines. They do.
- the node **exits 0 on SIGTERM**, so the `exec` in the entrypoint really does make it PID 1
  and a `docker stop` is a clean shutdown rather than a cut-short UTXO flush

**Not verified, and each is a real risk:**

- **a mainnet sync in this image.** Everything tested is regtest, which reaches a working state
  in seconds and exercises no I/O at all. Every timing and disk figure in this document comes
  from the bare-metal production and benchmark nodes. Container I/O through a volume driver is
  not free, and the second half of a sync is I/O-bound.
- **`docker compose up` end to end.** The compose file is validated and the smoke test runs the
  same two containers with the same wiring by hand — but a real `up` on mainnet starts a 1.2 TB
  sync, which is not something to trigger to tick a box.
- **restart and upgrade behaviour**: `docker compose pull && up -d` mid-sync, and whether the
  node resumes as cleanly from a container stop as it does from `systemctl stop`.
- **anything on arm64**, which cannot be tested because it cannot be built.
