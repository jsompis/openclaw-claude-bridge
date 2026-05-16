# OpenClaw Claude Bridge Dashboard

React/TypeScript/Vite dashboard for `openclaw-claude-bridge` runtime status, activity logs, sessions, context-window cards, and cleanup controls.

## Development

```bash
npm install
npm run dev
npm run build
npm run lint
```

The dev server proxies `/status` and `/cleanup` to the bridge status API.

## Environment

Set dashboard-specific Vite variables in `dashboard/.env` or export them before `npm run dev`.

| Variable | Default | Description |
|---|---:|---|
| `VITE_STATUS_API_TARGET` | `http://127.0.0.1:3458` | Vite dev proxy target for bridge `/status` and `/cleanup` APIs |

The dashboard displays bridge state produced by these root bridge variables; configure them in the repo-root `.env` (see `../.env.example`):

| Bridge variable | Default | Purpose |
|---|---:|---|
| `DASHBOARD_PASS` | — | Enables Basic Auth and `/cleanup` |
| `OPENCLAW_BRIDGE_STATUS_BIND` | `127.0.0.1` | Status/dashboard bind address; non-loopback requires `DASHBOARD_PASS` |
| `OPENCLAW_BRIDGE_STATUS_PORT` | `3458` | Dashboard/status API port |
| `IDLE_TIMEOUT_MS` | `120000` | Kill active CLI request after stdout inactivity |
| `HARD_TIMEOUT_MS` | `1200000` | Absolute max runtime for an active CLI request |
| `OPENCLAW_BRIDGE_STATE_DIR` | `./state` | Persisted bridge state and staged attachments |
| `OPENCLAW_BRIDGE_ATTACHMENT_MODE` | `passthrough` | Native attachment handling mode (`describe` disables non-text passthrough) |
| `OPENCLAW_BRIDGE_ATTACHMENT_PER_TURN_CAP` | `20` | Max non-text attachment parts per turn |
| `OPENCLAW_BRIDGE_ATTACHMENT_SESSION_BUDGET_MB` | `500` | Attachment staging disk budget |
| `OPENCLAW_BRIDGE_ATTACHMENT_MAX_BYTES` | `52428800` | Max decoded bytes per attachment |
| `OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS` | `30000` | Remote attachment download timeout |
| `OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_MAX_BYTES` | `OPENCLAW_BRIDGE_ATTACHMENT_MAX_BYTES` | Optional remote-only max bytes |
| `OPENCLAW_BRIDGE_ATTACHMENT_ROOTS` | unset | Local file attachment allowlist roots |
