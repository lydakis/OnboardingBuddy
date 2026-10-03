#!/bin/sh
# Run through Errand on the GB10. No Slack/email configuration is loaded here.
set -eu
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != aarch64 ]; then
  echo 'Run this through errand --on gb10 (Linux arm64)' >&2
  exit 1
fi
readiness_bootstrap="$HOME/.cache/onboarding-buddy/uv-bootstrap"
readiness_env="$HOME/.local/share/onboarding-buddy/readiness/.venv"
if [ ! -x "$readiness_bootstrap/bin/uv" ]; then
  python3 -m venv "$readiness_bootstrap"
  "$readiness_bootstrap/bin/pip" install --disable-pip-version-check uv
fi
npm ci --silent
npm run check
cd ml
UV_PROJECT_ENVIRONMENT="$readiness_env" "$readiness_bootstrap/bin/uv" sync --locked --python python3
"$readiness_env/bin/python" synthetic.py --rows 1000 --seed 42
"$readiness_env/bin/python" train.py --models catboost --seed 42
OB_TEST_ARTIFACTS=artifacts "$readiness_env/bin/python" -m unittest discover -p 'test_*.py'
"$readiness_env/bin/python" install_gb10.py --artifacts artifacts
cd ..
node --disable-warning=ExperimentalWarning scripts/classifier-smoke.ts ml/artifacts/snapshots.jsonl
