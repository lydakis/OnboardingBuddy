#!/bin/sh
# Existing connector settings come from the personal profile or Errand passenv.
set -eu
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != aarch64 ]; then
  echo 'Run this through errand --on gb10 (Linux arm64)' >&2
  exit 1
fi
readiness_config="$HOME/.config/onboarding-buddy/readiness.env"
test -f "$readiness_config" || { echo 'Run scripts/setup-classifier.sh first' >&2; exit 1; }
exec node --disable-warning=ExperimentalWarning --env-file=slack/sandbox.env --env-file="$HOME/.config/onboarding-buddy/runtime.env" --env-file="$readiness_config" src/main.ts
