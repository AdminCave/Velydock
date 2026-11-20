#!/usr/bin/env bash
# Browser tests against a freshly built, empty development stack.
#
#   ./scripts/tests/e2e.sh            reset the development stack, then run all browser tests
#   ./scripts/tests/e2e.sh --keep     reuse the running stack (it must not have been seeded before)
#
# Resetting deletes the data of the *development* stack (project "velydock-dev") only.
set -euo pipefail
cd "$(dirname "$0")/../.."

if [[ ${1:-} != --keep ]]; then
  ./scripts/dev-stack.sh down --volumes --remove-orphans
  rm -rf -- e2e/.auth          # signed-in browser states of the previous stack
  ./scripts/dev-stack.sh up -d --build --wait
else
  shift
fi

cd e2e
[[ -d node_modules ]] || npm ci --no-audit --no-fund
npx playwright test "$@"
