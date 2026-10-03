"""Capture only non-secret settings from the current GB10 app before restarting."""
import json
import os
import platform
import subprocess
from pathlib import Path

if platform.system() != "Linux" or platform.machine() != "aarch64":
    raise SystemExit("Run through errand --on gb10")

# Explicit allowlist: never copy API keys, bot tokens or credential variables.
names = """OB_DB_PATH OB_STATUS_PORT OB_STATUS_HOST OB_COMPANY_NAME OB_AGENT_NAME
OB_AGENT_SIGNATURE OB_MANAGER_SLACK_IDS OB_LIVE_RECIPIENT_ALLOWLIST OB_NEW_HIRE_CHANNEL
OB_EMAIL_MODE OB_EMAIL_FROM AGENTMAIL_INBOX_ID AGENTMAIL_BASE_URL OB_EMAIL_POLL_MS
OB_SLACK_MODE OB_LLM_MODE OB_NEMOCLAW_SANDBOX OB_LLM_BASE_URL OB_LLM_MODEL
OB_LLM_TIMEOUT_MS OB_LLM_DISABLE_THINKING OB_INVITE_MODE SLACK_TEAM_ID OB_SANDBOX_MODE
OB_READY_REQUIRE_INTAKE OB_READY_REQUIRE_PLAN_SENT OB_POLICY_PATH OB_DEPOT_ZONE
OB_TRAINING_URL OB_TAILORED_LESSONS""".split()
processes = []
for p in Path("/proc").iterdir():
    try:
        if (p.name.isdigit() and p.stat().st_uid == os.getuid()
                and (p / "comm").read_text().strip() == "node"
                and b"src/main.ts" in (p / "cmdline").read_bytes()):
            processes.append(p)
    except (FileNotFoundError, PermissionError):
        continue
if len(processes) != 1:
    raise SystemExit("Expected exactly one running app; refusing to guess its configuration")
p = processes[0]
selected = dict(entry.decode().split("=", 1) for entry in (p / "environ").read_bytes().split(b"\0")
                if entry.split(b"=", 1)[0].decode() in names)
script = r"""
const fs = require('node:fs');
const path = require('node:path');
const names = JSON.parse(process.argv[1]);
const config = Object.fromEntries(names.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
const root = path.join(process.env.HOME, '.config/onboarding-buddy');
fs.mkdirSync(root, {recursive: true});
const file = path.join(root, 'runtime.env');
fs.writeFileSync(file, '# Preserved non-secret GB10 app settings\n' + Object.entries(config)
  .map(([k,v]) => k + '=' + JSON.stringify(v)).join('\n') + '\n', {mode: 0o600});
fs.chmodSync(file, 0o600);
console.log(JSON.stringify({config: file, keys: Object.keys(config),
  allowlistCount: (config.OB_LIVE_RECIPIENT_ALLOWLIST || '').split(',').filter(Boolean).length}));
"""
subprocess.run(["node", "--env-file=" + str((p / "cwd").resolve() / "slack/sandbox.env"),
                "-e", script, json.dumps(names)], env=dict(os.environ, **selected), check=True)
