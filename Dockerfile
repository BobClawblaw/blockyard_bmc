# blockyard-bmc: one image carrying a Bitcoin Machine Code node and the BlockYard monitor.
#
# ONE IMAGE, TWO CONTAINERS. docker-compose.yml runs this image twice -- once as the node,
# once as the monitor -- with different entrypoints. One artifact to build, publish, pin and
# version, so the node and the window into it can never be a release apart; two containers, so
# each keeps its own restart policy, health check, log stream and stop timeout. The cost of
# carrying both in one image is the 31 MB bmc binary in the monitor's container and ~40 MB of
# JavaScript in the node's, against a datadir measured in terabytes. See docs/DESIGN.md.
#
# THE SOURCES ARE FETCHED, NOT COPIED. Both repositories are public, this box has no
# `docker buildx` (so no `--build-context`), and a release image should not depend on what
# happens to be checked out on the machine that builds it. `docker build .` works in an empty
# directory. Override BMC_REF / BLOCKYARD_REF to pin; both default to a commit measured to
# work together, not to a moving branch.
#
#   sudo docker build -t blockyard-bmc:dev .
#   sudo docker build --build-arg BMC_REF=<full-sha> --build-arg BLOCKYARD_REF=<full-sha> -t blockyard-bmc:0.1.0 .
#
# LINUX x86-64 ONLY. bmc is hand-written NASM ELF64 for the System V ABI; there is no arm64
# build (that port is a paused branch, halted 2026-09-08). Do not add a `platform: linux/arm64`
# target expecting it to work -- the assembler will not produce one.

# ---------------------------------------------------------------- stage 1: build bmc
#
# THE COMPILER IS PINNED TO gcc 13, AND THIS IS NOT A PREFERENCE. bmc builds with -Werror
# (its Makefile: "every nasm warning is a build failure", and the same for gcc), so a compiler
# that merely ANALYSES DIFFERENTLY fails the build. Measured 2026-09-24, same commit, same
# `make daemon/bmcbitcoind`:
#
#   gcc 12.2 (debian:bookworm-slim)  FAILS   -Werror=format-truncation, daemon/main.c:8564,8586
#   gcc 13.3 (ubuntu:24.04)          builds  -- the toolchain bmc is developed and tested on
#   gcc 14.2 (debian:trixie-slim)    FAILS   -Werror=format-truncation, rpc_node.c:3390 and
#                                            miniscript.c -- different sites again
#
# So the builder is ubuntu:24.04. Neither neighbouring release of gcc will do, and a future
# bump of this line needs that experiment repeated, not an assumption.
#
# The binary needs nothing but libc: measured 2026-09-24, `ldd` on the production build reports
# linux-vdso, libc.so.6 and ld-linux only. ubuntu:24.04's glibc is 2.39, so the runtime stage
# must be 2.39 or newer -- which is why it is trixie (2.41) rather than bookworm (2.36).
# Forwards is the direction glibc guarantees; backwards is not.
FROM ubuntu:24.04 AS bmc-build

ARG BMC_REPO=https://github.com/BobClawblaw/bitcoinmachinecode.git
# A FULL 40-character commit sha, a branch or a tag -- never an abbreviated sha. `git fetch`
# resolves a ref name or a whole object id; a short sha is neither, and the build fails with
# "couldn't find remote ref", which is how this line came to say so.
ARG BMC_REF=bc0b9007d8b8c024ab411fff731beecd3035b08c

RUN apt-get update && apt-get install -y --no-install-recommends \
      nasm gcc make python3 binutils libc6-dev git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# A pinned ref is fetched shallow: the history of this repository is large and none of it is
# needed to assemble a binary.
RUN git init -q . \
    && git remote add origin "$BMC_REPO" \
    && git fetch -q --depth 1 origin "$BMC_REF" \
    && git checkout -q FETCH_HEAD \
    && git rev-parse HEAD > /bmc-commit

# The daemon, and the five helpers it SPAWNS FROM ITS OWN DIRECTORY while it syncs
# (asm/daemon/main.c: it resolves them next to /proc/self/exe, so a helper that is not beside
# the binary is a silently missing index, not an error at start-up). bmc_cli is here for
# `docker exec` debugging. Measured on the bench harness 2026-09-21: the whole set builds in
# about 12 seconds, so there is nothing to gain by trimming it.
WORKDIR /src/asm
RUN make -j"$(nproc)" \
      daemon/bmcbitcoind \
      daemon/bmc_cli \
      daemon/bmc_build_tx_index \
      daemon/bmc_build_txospender_index \
      daemon/bmc_build_addr_hist \
      daemon/bmc_build_coinstats_hist \
      daemon/bmc_merge_index_runs

# ---------------------------------------------------------------- stage 2: fetch blockyard
FROM debian:trixie-slim AS blockyard-src

ARG BLOCKYARD_REPO=https://github.com/BobClawblaw/blockyard.git
ARG BLOCKYARD_REF=51491e985b7e49df0ccefb8fab9782a8bbf4bef9
# 1 keeps the DOS Diversions (~26 MB of shareware whose terms permit redistributing the whole
# package, exactly as BlockYard's own image ships it); 0 drops them and the pages say which
# file is missing.
ARG WITH_GAMES=1

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git init -q . \
    && git remote add origin "$BLOCKYARD_REPO" \
    && git fetch -q --depth 1 origin "$BLOCKYARD_REF" \
    && git checkout -q FETCH_HEAD \
    && git rev-parse HEAD > /blockyard-commit

# THE ADMINISTRATIVE SUITE IS REMOVED HERE, and this is the only place it can be.
# BlockYard's own container build excludes it through .dockerignore, but .dockerignore applies
# to a build CONTEXT and these files arrive by `git clone` inside the build, where it has no
# effect. The rule it enforces (AGENTS.md, "Releases while the wallet is unfinished"): the
# suite can spend money and has had no security review, so no release artifact carries it.
RUN rm -rf server/admin server/rpc/admin-allowlist.js public/js/admin public/css/admin.css \
           docs/PLAN-ADMIN-SUITE.md \
    && if [ "$WITH_GAMES" != "1" ]; then rm -rf games; fi \
    && test ! -e server/admin && test ! -e public/js/admin

# ---------------------------------------------------------------- stage 3: the runtime
# trixie (glibc 2.41), not the default bookworm tag (2.36): the daemon above is linked
# against ubuntu:24.04's 2.39 and would not start on 2.36. See stage 1.
FROM node:22-trixie-slim

ARG BMC_REF
ARG BLOCKYARD_REF
LABEL org.opencontainers.image.title="blockyard-bmc" \
      org.opencontainers.image.description="A Bitcoin Machine Code node and the BlockYard monitor, in one image" \
      org.opencontainers.image.source="https://github.com/BobClawblaw/blockyard_bmc" \
      bmc.commit="$BMC_REF" \
      blockyard.commit="$BLOCKYARD_REF"

WORKDIR /app

# the node: the daemon and the helpers it spawns, all in one directory, as it requires
COPY --from=bmc-build /src/asm/daemon/bmcbitcoind \
                      /src/asm/daemon/bmc_cli \
                      /src/asm/daemon/bmc_build_tx_index \
                      /src/asm/daemon/bmc_build_txospender_index \
                      /src/asm/daemon/bmc_build_addr_hist \
                      /src/asm/daemon/bmc_build_coinstats_hist \
                      /src/asm/daemon/bmc_merge_index_runs \
                      /usr/local/lib/bmc/
COPY --from=bmc-build /bmc-commit /app/BMC_COMMIT
# bmc_cli on PATH, for `docker exec blockyard-bmc-node bmc_cli getblockchaininfo`
RUN ln -s /usr/local/lib/bmc/bmc_cli /usr/local/bin/bmc_cli

# the monitor: the same set BlockYard's own image ships, minus the administrative suite
COPY --from=blockyard-src /src/package.json /src/CHANGELOG.md /src/SECURITY.md \
                          /src/NOTICE /src/LICENSE /src/README.md /app/
COPY --from=blockyard-src /src/server /app/server
COPY --from=blockyard-src /src/public /app/public
COPY --from=blockyard-src /src/scripts /app/scripts
COPY --from=blockyard-src /src/bin /app/bin
COPY --from=blockyard-src /src/docs /app/docs
COPY --from=blockyard-src /src/config/pool-map.json /app/config/pool-map.json
COPY --from=blockyard-src /blockyard-commit /app/BLOCKYARD_COMMIT
# games/ is optional at build time (WITH_GAMES); this keeps the build working either way
COPY --from=blockyard-src /src/gam[e]s /app/games

COPY entrypoint /app/entrypoint

# Both services run as 1000:1000 -- the `node` user this image already has. It must be the
# SAME uid on both, because the monitor reads the node's RPC cookie and bmc writes that file
# mode 0600 (always: `rpccookieperms` is one of the options bmc accepts without effect).
#
# EVERY MOUNT POINT IS CREATED AND CHOWNED HERE, INCLUDING THE NESTED ONES. A named volume
# takes its initial ownership from the image's directory at that path; where the image has no
# such directory, Docker makes one owned by ROOT, and a container running as 1000 then cannot
# write into its own volume. Creating only /data is not enough -- the volumes mount at
# /data/bmc and /data/blockyard, so those are the paths that must exist. Measured 2026-09-24:
# without this the node dies at start-up on EACCES opening /data/bmc/bitcoin.conf.
RUN mkdir -p /data/bmc /data/blockyard/state /app/state \
    && chown -R 1000:1000 /data /app/state

ENV BMC_HOME=/usr/local/lib/bmc \
    BMC_DATADIR=/data/bmc \
    BLOCKYARD_DATA=/data/blockyard/state \
    BLOCKYARD_CONFIG=/data/blockyard/local.json \
    NODE_ENV=production

USER 1000:1000

# No ENTRYPOINT and no CMD on purpose: this image is two programs, and the compose file picks
# which one a container is by naming its entrypoint. Running it with neither is a mistake that
# should say so rather than guess.
ENTRYPOINT ["/app/entrypoint/which.sh"]
