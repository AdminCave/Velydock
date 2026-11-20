#!/usr/bin/env bash
# Development and test stack (see docker-compose.dev.yml). Passes its arguments to docker compose:
#
#   ./scripts/dev-stack.sh up -d --build --wait     start (builds the image from this checkout)
#   ./scripts/dev-stack.sh logs -f velydock
#   ./scripts/dev-stack.sh down -v                  stop and delete the development data
#
# It runs under the project name "velydock-dev" and never touches a real installation.
set -euo pipefail
cd "$(dirname "$0")/.."
exec docker compose -p velydock-dev --env-file .env.dev -f docker-compose.yml -f docker-compose.dev.yml "$@"
