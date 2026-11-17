#!/bin/bash
# Installs Tempo's Find My helper for the current user. Safe to run again.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Library/Application Support/Tempo"
mkdir -p "$APP"
cp "$DIR/tempo_findmy.py" "$APP/tempo_findmy.py"

# uv runs the script with its own Python and packages (no admin rights needed)
if ! command -v uv >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/uv" ]; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
"$UV" run --script "$APP/tempo_findmy.py" help >/dev/null   # pre-fetch packages

# background collector, started at login and kept alive
PLIST="$HOME/Library/LaunchAgents/com.tempo.findmy.plist"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.tempo.findmy</string>
  <key>ProgramArguments</key><array><string>$UV</string><string>run</string><string>--script</string><string>$APP/tempo_findmy.py</string><string>poll</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP/poll.log</string>
  <key>StandardErrorPath</key><string>$APP/poll.log</string>
</dict></plist>
PL
# reinstall: stop the old job and wait until macOS has really unloaded it (bootout returns early)
launchctl bootout "gui/$(id -u)/com.tempo.findmy" 2>/dev/null || true
for _ in $(seq 1 20); do launchctl print "gui/$(id -u)/com.tempo.findmy" >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/com.tempo.findmy" || { echo "Couldn't start the background collector (com.tempo.findmy)."; exit 1; }

# register the local MCP server with the Claude desktop app (keeps any existing servers)
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
mkdir -p "$(dirname "$CFG")"
"$UV" run --no-project python3 - "$CFG" "$UV" "$APP/tempo_findmy.py" <<'PY'
import json, sys, pathlib
cfg, uv, script = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
data = json.loads(cfg.read_text()) if cfg.exists() and cfg.read_text().strip() else {}
data.setdefault("mcpServers", {})["tempo_location"] = {"command": uv, "args": ["run", "--script", script, "mcp"]}
cfg.write_text(json.dumps(data, indent=2))
PY
echo "Installed. Next: sign in with  \"$UV\" run --script \"$APP/tempo_findmy.py\" login"
