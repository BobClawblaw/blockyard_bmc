# Thin wrappers. Everything here is a docker command you could type; they exist so the
# pinned arguments do not have to be remembered.
#
# DOCKER is `sudo -n docker` because this box's account is not in the docker group. On a
# machine where it is: `make DOCKER=docker build`.

DOCKER ?= sudo -n docker
IMAGE  ?= blockyard-bmc:dev

.PHONY: build smoke up down logs shell clean pins help

help:
	@echo 'make build   build $(IMAGE) from the pinned commits'
	@echo 'make smoke   boot the package on regtest and assert the wiring (scripts/smoke.sh)'
	@echo 'make up      docker compose up -d      (reads .env)'
	@echo 'make down    docker compose down       (keeps the chain)'
	@echo 'make logs    follow the node'"'"'s log'
	@echo 'make shell   a shell in the node container'
	@echo 'make pins    the commits this image would be built from, and the ones checked out here'

build:
	$(DOCKER) build -t $(IMAGE) .

smoke: build
	IMAGE=$(IMAGE) DOCKER="$(DOCKER)" scripts/smoke.sh

up:
	$(DOCKER) compose up -d

down:
	$(DOCKER) compose down

logs:
	$(DOCKER) compose logs -f bmc

shell:
	$(DOCKER) compose exec bmc /bin/sh

# What the image says it was built from, beside what is checked out on this machine -- the two
# drift, and the image's answer is the one that matters.
pins:
	@printf 'image  bmc        %s\n' "$$($(DOCKER) run --rm --entrypoint /bin/cat $(IMAGE) /app/BMC_COMMIT 2>/dev/null || echo '(no image)')"
	@printf 'image  blockyard  %s\n' "$$($(DOCKER) run --rm --entrypoint /bin/cat $(IMAGE) /app/BLOCKYARD_COMMIT 2>/dev/null || echo '(no image)')"
	@printf 'local  bmc        %s\n' "$$(git -C /storage/bitcoinmachinecode rev-parse HEAD 2>/dev/null || echo '(not checked out here)')"
	@printf 'local  blockyard  %s\n' "$$(git -C /storage/blockyard rev-parse HEAD 2>/dev/null || echo '(not checked out here)')"

# Removes the image and any smoke-test leftovers. NOT the compose volumes: `make down` keeps
# the chain on purpose, and deleting a terabyte takes a deliberate `docker compose down -v`.
clean:
	-$(DOCKER) rm -f blockyard-bmc-smoke-node blockyard-bmc-smoke-monitor 2>/dev/null
	-$(DOCKER) volume rm -f blockyard-bmc-smoke-data 2>/dev/null
	-$(DOCKER) network rm blockyard-bmc-smoke-net 2>/dev/null
	-$(DOCKER) rmi $(IMAGE) 2>/dev/null
