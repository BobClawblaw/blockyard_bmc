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
> longer, sometimes much longer, on anything else. Start on `signet` or `testnet4` unless you
> have provisioned for that.
>
> **Not publishable yet.** bmc carries no licence file, so redistributing its binary — which is
> what pushing this image to a registry does — is not something anyone may do until the
> operator adds one. Build it locally; do not push it. See [docs/DESIGN.md](docs/DESIGN.md).

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

BlockYard is Apache-2.0 (its `LICENSE` and `NOTICE` travel in the image). The DOS Diversions'
game files are shareware whose terms permit redistributing each package whole, and they travel
whole; set `--build-arg WITH_GAMES=0` to leave them out. **bmc has no licence file**, which is
what stops this image being published at all — see [docs/DESIGN.md](docs/DESIGN.md).
