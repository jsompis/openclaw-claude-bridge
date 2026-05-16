#!/bin/bash
set -euo pipefail

# openclaw-claude-bridge — macOS LaunchAgent installer
# Detects paths, reads .env, generates plist, loads service

LABEL="com.openclaw.claude-bridge"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"

# --- Detect paths ---

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

build_env_entries() {
  local node_bin="$1"
  local bridge_dir="$2"
  local env_file="$3"
  "$node_bin" - "$bridge_dir" "$env_file" <<'NODE'
const path = require('path');
const [bridgeDir, envFile] = process.argv.slice(2);
const { loadEnvFile } = require(path.join(bridgeDir, 'src', 'env-loader'));

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const parsed = {};
loadEnvFile(envFile, parsed);
for (const [key, value] of Object.entries(parsed)) {
  process.stdout.write(`        <key>${xmlEscape(key)}</key>\n        <string>${xmlEscape(value)}</string>\n`);
}
NODE
}

NODE_BIN="$(which node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found in PATH"
  echo "  Install Node.js: brew install node"
  exit 1
fi

if [[ "${OPENCLAW_BRIDGE_INSTALL_MAC_PRINT_ENV:-}" == "1" ]]; then
  TEST_ENV_FILE="${OPENCLAW_BRIDGE_INSTALL_MAC_ENV_FILE:-$BRIDGE_DIR/.env}"
  build_env_entries "$NODE_BIN" "$BRIDGE_DIR" "$TEST_ENV_FILE"
  exit 0
fi

CLAUDE_BIN="$(which claude 2>/dev/null || true)"
if [[ -z "$CLAUDE_BIN" ]]; then
  echo "ERROR: claude not found in PATH"
  echo "  Install Claude Code: npm install -g @anthropic-ai/claude-code"
  exit 1
fi

CLAUDE_DIR="$(dirname "$CLAUDE_BIN")"
NODE_DIR="$(dirname "$NODE_BIN")"

echo "=== openclaw-claude-bridge macOS installer ==="
echo "  Bridge dir:  $BRIDGE_DIR"
echo "  Node:        $NODE_BIN"
echo "  Claude:      $CLAUDE_BIN"

# --- Check claude auth ---

echo ""
echo "Checking claude auth status..."
if ! "$CLAUDE_BIN" auth status 2>&1 | grep -q "Logged in"; then
  echo "WARNING: claude does not appear to be logged in"
  echo "  Run: claude auth login"
  echo "  Continuing anyway..."
else
  echo "  Claude auth OK"
fi

# --- Check .env ---

ENV_FILE="${OPENCLAW_BRIDGE_INSTALL_MAC_ENV_FILE:-$BRIDGE_DIR/.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo ""
  echo "ERROR: .env not found at $ENV_FILE"
  echo "  Run: cp .env.example .env && edit .env"
  exit 1
fi

# --- Build PATH ---

# Collect unique dirs for PATH
PATH_PARTS="/usr/local/bin:/usr/bin:/bin"
for dir in "$NODE_DIR" "$CLAUDE_DIR" "$HOME/.local/bin" "/opt/homebrew/bin"; do
  if [[ ":$PATH_PARTS:" != *":$dir:"* ]]; then
    PATH_PARTS="$dir:$PATH_PARTS"
  fi
done

# --- Read .env into plist EnvironmentVariables ---
# Keep parsing equivalent to src/env-loader.js for simple KEY=VALUE / export /
# quoted values / safe inline comments, without eval'ing the .env as shell.

ENV_ENTRIES="$(build_env_entries "$NODE_BIN" "$BRIDGE_DIR" "$ENV_FILE")"
if [[ -n "$ENV_ENTRIES" ]]; then
  ENV_ENTRIES+=$'\n'
fi

# --- Generate plist ---

mkdir -p "$(dirname "$PLIST_PATH")"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>src/index.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${BRIDGE_DIR}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${PATH_PARTS}</string>
        <key>HOME</key>
        <string>${HOME}</string>
${ENV_ENTRIES}    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${BRIDGE_DIR}/bridge.log</string>

    <key>StandardErrorPath</key>
    <string>${BRIDGE_DIR}/bridge-error.log</string>
</dict>
</plist>
PLIST

echo ""
echo "Generated plist: $PLIST_PATH"

# --- Load service ---

echo ""
echo "Loading LaunchAgent..."

# Unload old service if running
DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/$LABEL" &>/dev/null; then
  echo "  Unloading existing service..."
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  sleep 1
fi

launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
echo "  Service loaded"

# --- Verify ---

echo ""
sleep 2
if launchctl print "$DOMAIN/$LABEL" &>/dev/null; then
  echo "=== Installed successfully ==="
else
  echo "WARNING: Service may not have started correctly"
  echo "  Check: launchctl print $DOMAIN/$LABEL"
fi

echo ""
echo "Management commands:"
echo "  Status:   launchctl list | grep openclaw-claude-bridge"
echo "  Restart:  launchctl bootout $DOMAIN/$LABEL && launchctl bootstrap $DOMAIN $PLIST_PATH"
echo "  Logs:     tail -f $BRIDGE_DIR/bridge.log"
echo "  Errors:   tail -f $BRIDGE_DIR/bridge-error.log"
echo "  Health:   curl http://127.0.0.1:3456/health"
