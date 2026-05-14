'use strict';

require('./env-loader').loadDefaultEnv();

const http = require('http');
const { app, statusApp, stats, saveState } = require('./server');

const API_PORT    = parseInt(process.env.OPENCLAW_BRIDGE_PORT)    || 3456;
const STATUS_PORT = parseInt(process.env.OPENCLAW_BRIDGE_STATUS_PORT) || 3458;

// Status server bind — default localhost. Set OPENCLAW_BRIDGE_STATUS_BIND=0.0.0.0
// (or another interface) to expose the dashboard on LAN. When binding to a
// non-loopback interface, DASHBOARD_PASS must be set so the dashboard is not
// fully open to the network. Fail closed if the operator forgot the password.
const STATUS_BIND_RAW = process.env.OPENCLAW_BRIDGE_STATUS_BIND;
const STATUS_BIND = STATUS_BIND_RAW && STATUS_BIND_RAW.trim() ? STATUS_BIND_RAW.trim() : '127.0.0.1';
const STATUS_BIND_IS_LOOPBACK = STATUS_BIND === '127.0.0.1' || STATUS_BIND === '::1' || STATUS_BIND === 'localhost';
if (!STATUS_BIND_IS_LOOPBACK && !process.env.DASHBOARD_PASS) {
    console.error(`[openclaw-claude-bridge] FATAL: OPENCLAW_BRIDGE_STATUS_BIND=${STATUS_BIND} exposes the dashboard, but DASHBOARD_PASS is not set.`);
    console.error('[openclaw-claude-bridge] Refusing to start. Either set DASHBOARD_PASS, or unset OPENCLAW_BRIDGE_STATUS_BIND to bind localhost-only.');
    process.exit(1);
}

// API server — localhost only (OpenClaw access)
const apiServer = http.createServer(app).listen(API_PORT, '127.0.0.1', () => {
    console.log(`[openclaw-claude-bridge] API     → http://127.0.0.1:${API_PORT}`);
});

// Status server — bind controlled by OPENCLAW_BRIDGE_STATUS_BIND (default 127.0.0.1).
const statusServer = http.createServer(statusApp).listen(STATUS_PORT, STATUS_BIND, () => {
    const advertised = STATUS_BIND_IS_LOOPBACK ? '127.0.0.1' : STATUS_BIND;
    console.log(`[openclaw-claude-bridge] Status  → http://${advertised}:${STATUS_PORT}`);
    if (!STATUS_BIND_IS_LOOPBACK) {
        console.warn(`[openclaw-claude-bridge] Status dashboard exposed on ${STATUS_BIND}; Basic Auth required (admin:DASHBOARD_PASS).`);
    }
});

// --- Graceful shutdown ---
// When systemd sends SIGTERM (restart/stop), wait for active requests to finish
// before shutting down. This prevents OpenClaw's session from getting corrupted
// by a dropped SSE connection mid-response.
//
// Requires KillMode=process in the systemd service so that SIGTERM is only sent
// to Node.js, not to Claude CLI child processes.
//
// Safety net: systemd TimeoutStopSec=600 will SIGKILL if we haven't exited.
// The idle timeout in claude.js ensures stuck processes get killed (2 min no output),
// so in practice this code just waits for active requests to finish naturally.
let shuttingDown = false;

function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[openclaw-claude-bridge] ${signal} received — stopping new connections, waiting for active requests...`);

    // Save state before shutdown
    saveState();

    // Stop accepting new connections
    apiServer.close();
    statusServer.close();

    // Wait for active requests to finish — no timeout on our side.
    // The idle timeout in claude.js kills stuck processes (2 min no output).
    // systemd TimeoutStopSec is the ultimate safety net.
    const check = setInterval(() => {
        const active = stats.activeRequests;
        if (active === 0) {
            clearInterval(check);
            console.log(`[openclaw-claude-bridge] All requests completed — shutting down cleanly`);
            process.exit(0);
        } else {
            console.log(`[openclaw-claude-bridge] Waiting for ${active} active request(s)...`);
        }
    }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
