#!/usr/bin/env bash
# Development and test stack (see docker-compose.dev.yml). Passes its arguments to docker compose:
#
#   ./scripts/dev-stack.sh up -d --build --wait     start (builds the image from this checkout)
#   ./scripts/dev-stack.sh logs -f velydock
#   ./scripts/dev-stack.sh down -v                  stop and delete the development data
#
# It runs under the project name "velydock-dev" and never touches a real installation.
#
# A second stack beside the first (to run the browser tests while somebody uses the first one):
# give it a name and ports of its own. The browser tests read the same variables.
#
#   export VELYDOCK_DEV_PROJECT=velydock-e2e VELYDOCK_DEV_IMAGE=velydock:e2e \
#          DEV_HTTPS_PORT=7443 PUBLIC_PORT_SUFFIX=:7443 \
#          DEV_KEYCLOAK_PORT=17080 DEV_POSTGRES_PORT=17432 DEV_MAIL_PORT=17025
#   ./scripts/tests/e2e.sh
set -euo pipefail
cd "$(dirname "$0")/.."
exec docker compose -p "${VELYDOCK_DEV_PROJECT:-velydock-dev}" --env-file .env.dev \
  -f docker-compose.yml -f docker-compose.dev.yml "$@"
