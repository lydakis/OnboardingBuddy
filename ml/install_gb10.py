"""Install the verified classifier as a persistent GB10 user service."""
import argparse
import json
import os
import platform
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

from serve import Predictor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() != "aarch64":
        raise SystemExit("Run installation through errand --on gb10 (Linux arm64)")
    # Errand jobs do not inherit a login session's user-bus environment.
    runtime = Path("/run/user") / str(os.getuid())
    if not (runtime / "bus").exists():
        raise SystemExit("GB10 user service manager is unavailable")
    service_env = dict(os.environ, XDG_RUNTIME_DIR=str(runtime),
                       DBUS_SESSION_BUS_ADDRESS=f"unix:path={runtime / 'bus'}")
    predictor = Predictor(args.artifacts)  # Verify everything before changing the unit.
    version = predictor.identity["model_version"]
    root = Path.home() / ".local/share/onboarding-buddy/readiness"
    release = root / "releases" / version
    artifacts = release / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).resolve().parent
    for filename in ("serve.py", "model.py", "readiness.py"):
        shutil.copy2(source / filename, release / filename)
    for filename in ("catboost.cbm", "catboost-manifest.json"):
        shutil.copy2(args.artifacts / filename, artifacts / filename)
    python = root / ".venv/bin/python"
    if not python.exists():
        raise SystemExit("Install the locked dependencies into the persistent GB10 virtual environment first")
    unit_dir = Path.home() / ".config/systemd/user"
    unit_dir.mkdir(parents=True, exist_ok=True)
    unit = unit_dir / "onboarding-buddy-classifier.service"
    marker = "# Managed by OnboardingBuddy ml/install_gb10.py"
    if unit.exists() and not unit.read_text().startswith(marker):
        raise SystemExit("Existing unit is not managed by this installer; refusing to replace it")
    unit.write_text(f'''{marker}
[Unit]
Description=Onboarding Buddy local CatBoost classifier

[Service]
Type=simple
WorkingDirectory={release}
ExecStart={python} {release / "serve.py"} --artifacts {artifacts} --port 4610
Restart=on-failure
RestartSec=2
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
''')
    config_dir = Path.home() / ".config/onboarding-buddy"
    config_dir.mkdir(parents=True, exist_ok=True)
    config = config_dir / "readiness.env"
    if not config.exists():
        config.write_text("# GB10 classifier settings; contains no credentials\n"
                          "OB_CLASSIFIER_MODE=demo\n"
                          "OB_CLASSIFIER_URL=http://127.0.0.1:4610\n"
                          "OB_CLASSIFIER_TIMEOUT_MS=5000\n")
        config.chmod(0o600)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True, env=service_env)
    subprocess.run(["systemctl", "--user", "enable", "onboarding-buddy-classifier.service"], check=True, env=service_env)
    subprocess.run(["systemctl", "--user", "restart", "onboarding-buddy-classifier.service"], check=True, env=service_env)
    for _ in range(40):
        try:
            with urllib.request.urlopen("http://127.0.0.1:4610/health", timeout=1) as response:
                identity = json.load(response)
            if identity.get("model_version") == version and identity.get("ready") is True:
                print(json.dumps({"service": unit.name, "release": str(release), "config": str(config), "health": identity}, indent=2))
                return
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(0.25)
    raise SystemExit("Classifier did not become healthy with the expected artifact")


if __name__ == "__main__":
    main()
