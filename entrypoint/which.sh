#!/bin/sh
# The default entrypoint, reached only when a container was started without choosing one.
# This image is two programs; guessing which one was meant is worse than saying so.
cat >&2 <<'EOF'
blockyard-bmc: this image holds two programs and you must name one.

  the node     entrypoint: /app/entrypoint/bmc.sh
  the monitor  entrypoint: /app/entrypoint/blockyard.sh

docker-compose.yml in this project runs both, wired together. To run one by hand:

  docker run --rm -v bmc-data:/data/bmc \
    --entrypoint /app/entrypoint/bmc.sh blockyard-bmc:dev

Versions in this image:
EOF
printf '  bmc        %s\n' "$(cat /app/BMC_COMMIT 2>/dev/null || echo unknown)" >&2
printf '  blockyard  %s\n' "$(cat /app/BLOCKYARD_COMMIT 2>/dev/null || echo unknown)" >&2
exit 64
