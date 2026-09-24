# blockyard-bmc

A **Bitcoin Machine Code** node and the **BlockYard** monitor in one Docker package, already
wired to each other: `docker compose up -d` gives a syncing node and a browser page that shows
the sync, the mempool, the block space, the peers and the chain, with nothing configured by
hand.

The two belong together. BlockYard's log parsers were written against bmc's log grammar and
understand nothing of Bitcoin Core's, and bmc serves its own address index — the one thing
BlockYard otherwise builds for itself over half an hour and 124 GB. BlockYard's existing
Umbrel package is the Core pairing, and it has to turn both of those off.

---

> ### Read this before you run it
>
> **bmc is experimental and unaudited.** Its own README says to run it "for study and
> evaluation, on a machine you can afford to lose, with no funds near it". A Docker image does
> not change that. For a node holding value, run [Bitcoin Core](https://bitcoincore.org).
>
> **linux/amd64 only.** bmc is hand-written NASM ELF64. There is no arm64 build — not an Apple
> Silicon Mac, not a Raspberry Pi. The build fails cleanly on those rather than producing
> something that will not run.
>
> **Mainnet needs about 1.2 TB and roughly a day of syncing** on a fast NVMe and a fast CPU;
> longer, sometimes much longer, on anything else. It is the default deliberately — so the
> claim is checkable against your own Core node — but provision for it, or start on `signet`
> or `testnet4`, which fit on an ordinary disk.
>
> **Still unpublished, but no longer blocked.** Both projects are Apache-2.0 as of
> 2026-09-24, so this image may be redistributed. What remains before pushing one is a
> decision, not a licence: see [docs/DESIGN.md](docs/DESIGN.md).

---

## Run it

```sh
cp .env.example .env
$EDITOR .env                      # at minimum, read the disk note and pick BMC_CHAIN
sudo docker compose up -d
sudo docker compose logs -f bmc   # the node's own log, as it boots and starts syncing
```

Then open `http://<host>:21000`. The first admin password is whatever you set as
`BLOCKYARD_ADMIN_PASSWORD`, or, if you left it empty, a generated one printed once in the
monitor's log:

```sh
sudo docker compose logs blockyard | grep -i password
```

The node takes a couple of minutes before it answers RPC — it reloads its archive and its UTXO
set first — and the monitor will show it offline until then. That is expected, and watching it
come up is most of what this package is for.

## Watch it sync, and A/B it against your own Core

The monitor polls the node throughout its initial sync — watching a chain arrive from genesis
is most of what this package is for. Point it at a Bitcoin Core you already run and the two sit
side by side, same page, same charts, same picker:

```sh
# in .env
CORE_RPC_URL=http://192.0.2.10:8332     # your Core, on the LAN or this host
CORE_RPC_USER=...
CORE_RPC_PASSWORD=...
```

Nothing is started for you — this points at an existing node, because a second chain here would
double the disk. If Core's credential is a cookie file rather than a user and password, mount
its datadir with the override file:

```sh
sudo docker compose -f docker-compose.yml -f docker-compose.core.yml up -d
```

The package ships `BMC_BOOT_CATCHUP=0`, which is **not** bmc's default and is what makes
watching possible at all: with bmc's default the block download runs inside the boot phase and
the RPC server starts only after it, so on a fresh mainnet datadir nothing answers RPC until
the entire sync has finished. Measured 2026-09-24 — boot phase `0.07 s` and chain RPCs live
immediately with it off, against hours of an unreachable-looking node with it on.

**If you are timing a sync rather than watching one, stop the monitor:**

```sh
sudo docker compose stop blockyard      # the node runs entirely unpolled
sudo docker compose start blockyard     # ...and watch again when it is done
```

A polled node is a fine node and a poor stopwatch. You do **not** need to change
`BMC_BOOT_CATCHUP` for a comparable run: `bootcatchup=0` is what every published bmc benchmark
already used (runs 27, 28 and 29, all MuHash-identical to Core), and bmc made it the default on
2026-09-24. `docs/DESIGN.md`, "Watching the sync", has the measurements.

### Useful commands

```sh
sudo docker compose exec bmc bmc_cli -datadir=/data/bmc getblockchaininfo
sudo docker compose logs -f blockyard
sudo docker compose down                     # stops both; the volumes keep the chain
sudo docker compose down -v                  # ...and deletes the chain. There is no undo.
```

`docker compose stop` gives the node up to 300 seconds to flush its UTXO set. Let it finish:
killing it early costs a long recovery on the next boot.

## What is in the image

| | |
|---|---|
| `bmcbitcoind` + its five index helpers + `bmc_cli` | built from a pinned commit with NASM and gcc |
| BlockYard's server, browser app and docs | copied from a pinned commit |
| the administrative suite | **removed**, and the build asserts it is gone |

One image, run twice: `entrypoint/bmc.sh` makes a container the node,
`entrypoint/blockyard.sh` makes it the monitor. One artifact to build and pin, so the node and
its monitor can never be a release apart; two containers, so each keeps its own restart policy,
health check, log stream and stop timeout. The reasoning, and the two shapes rejected, are in
[docs/DESIGN.md](docs/DESIGN.md).

## How they find each other

- **RPC over the shared volume's cookie.** bmc writes `<datadir>/<chain>/.cookie` mode 0600;
  the monitor mounts that datadir read-only and reads it. No password is in the compose file
  or the environment. Both containers run as uid 1000 so that file is readable.
- **A fixed compose subnet.** bmc ignores `rpcbind` unless an `rpcallowip` accompanies it, so
  the network's subnet is pinned in `docker-compose.yml` and the node admits exactly that /24.
- **The node's log, followed as a file.** `printtoconsole=1` gives `docker logs`; the same
  lines land in `debug.log` on the shared volume, which the monitor follows.

## Configuration

Everything is in `.env` — see `.env.example`, which documents each knob and what the index
switches cost on disk. Both containers render their configs from the environment on **every**
start, so a change to `.env` needs only `docker compose up -d`; editing a config inside a
container is pointless, as the next start overwrites it.

Two files are never rewritten and survive restarts: the Display settings you choose in the UI,
and the monitor's accounts, sessions and history.

## Building

```sh
sudo docker build -t blockyard-bmc:dev .
sudo docker build --build-arg BMC_REF=<commit> --build-arg BLOCKYARD_REF=<commit> -t blockyard-bmc:0.1.0 .
```

The build clones both public repositories at pinned commits, so it works in an empty directory
and does not depend on what happens to be checked out on the machine. bmc's assembly build
takes about 12 seconds; the rest is `apt-get` and file copies.

## Licences

Both projects are **Apache-2.0**: BlockYard's `LICENSE` and `NOTICE` travel in the image, and
bmc has been Apache-2.0 since 2026-09-24. bmc's own NOTICE is worth reading before running it —
it states the authorship position and why the warranty disclaimer is the point rather than
boilerplate.

The DOS Diversions' game files are shareware whose terms permit redistributing each package
whole, and they travel whole; `--build-arg WITH_GAMES=0` leaves them out.
