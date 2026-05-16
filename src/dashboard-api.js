'use strict';

// Status / dashboard HTTP app. Bind interface is controlled by src/index.js;
// this file only knows about routes, auth, and serving the React build.

const express = require('express');
const path = require('path');

const {
    stats,
    channelMap,
    requestLog,
    globalActivity,
} = require('./state-store');
const { cleanupSessions, getSessionInfo } = require('./session-cleanup');
const { getContextWindow, getLiveProcessInfo } = require('./claude');

const statusApp = express();

statusApp.use(express.json());

// Dashboard password protection (Basic Auth).
// When DASHBOARD_PASS is set, every status/dashboard route requires the header.
// When it is not set, the dashboard relies on localhost-only bind for safety
// (index.js refuses to bind a non-loopback interface without a password).
const DASHBOARD_PASS = process.env.DASHBOARD_PASS;
const hasDashboardAuth = !!DASHBOARD_PASS;
if (hasDashboardAuth) {
    const expected = 'Basic ' + Buffer.from('admin:' + DASHBOARD_PASS).toString('base64');
    statusApp.use((req, res, next) => {
        if (req.headers.authorization === expected) return next();
        res.setHeader('WWW-Authenticate', 'Basic realm="Dashboard"');
        res.status(401).send('Unauthorized');
    });
}

// Destructive routes (/cleanup) always require Basic Auth, regardless of bind.
// Without DASHBOARD_PASS the route is disabled (use the CLI instead).
function requireDashboardAuth(req, res, next) {
    if (hasDashboardAuth) return next();
    res.status(403).json({
        error: 'dashboard_password_required',
        message: 'Set DASHBOARD_PASS to enable this endpoint. Without a password the dashboard is read-only and bound to localhost.',
    });
}

function firstHeader(value) {
    if (Array.isArray(value)) return value[0];
    return value;
}

function isLoopbackHost(hostname) {
    const normalized = String(hostname || '').toLowerCase();
    return normalized === 'localhost'
        || normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '[::1]'
        || normalized.startsWith('127.');
}

function hostNameFromHeader(hostHeader) {
    if (!hostHeader) return null;
    try {
        return new URL(`http://${hostHeader}`).hostname;
    } catch {
        return String(hostHeader).split(':')[0];
    }
}

function originMatchesOrIsTrustedLocal(req, originHeader) {
    if (!originHeader) return true;
    if (originHeader === 'null') return false;

    try {
        const origin = new URL(originHeader);
        const requestHost = firstHeader(req.headers.host);
        const requestHostName = hostNameFromHeader(requestHost);

        if (requestHost && origin.host === requestHost) return true;

        // Preserve Vite/dev-proxy and local CLI/API usability: a loopback dashboard
        // origin may proxy to another loopback host/port, but non-local browser
        // origins must not drive destructive cleanup with ambient Basic Auth.
        return isLoopbackHost(origin.hostname) && isLoopbackHost(requestHostName);
    } catch {
        return false;
    }
}

function hasCleanupApiIntent(req) {
    const csrfHeader = firstHeader(req.headers['x-openclaw-bridge-csrf']);
    const requestedWith = firstHeader(req.headers['x-requested-with']);
    return csrfHeader === 'cleanup' || requestedWith === 'OpenClawBridge';
}

function requireCleanupCsrf(req, res, next) {
    const secFetchSite = String(firstHeader(req.headers['sec-fetch-site']) || '').toLowerCase();
    const origin = firstHeader(req.headers.origin);

    if (secFetchSite === 'cross-site' || !originMatchesOrIsTrustedLocal(req, origin)) {
        res.status(403).json({
            error: 'cleanup_csrf_rejected',
            message: 'Cross-site cleanup requests are not allowed.',
        });
        return;
    }

    if (!hasCleanupApiIntent(req)) {
        res.status(403).json({
            error: 'cleanup_csrf_required',
            message: 'POST /cleanup requires X-OpenClaw-Bridge-CSRF: cleanup or X-Requested-With: OpenClawBridge.',
        });
        return;
    }

    next();
}

// Serve React dashboard (built files)
statusApp.use(express.static(path.join(__dirname, '../dashboard/dist')));

statusApp.get('/status', (req, res) => {
    res.json({
        status: 'running',
        uptime: Math.floor((Date.now() - stats.startedAt) / 1000),
        startedAt: stats.startedAt,
        totalRequests: stats.totalRequests,
        activeRequests: stats.activeRequests,
        lastRequestAt: stats.lastRequestAt,
        lastModel: stats.lastModel,
        errors: stats.errors,
        sessions: getSessionInfo(),
        liveProcesses: getLiveProcessInfo(),
        channels: Array.from(channelMap.entries()).map(([label, val]) => ({
            label: label.replace(/^Guild\s+/, '').slice(0, 40),
            sessionId: val.sessionId.slice(0, 8),
            age: Math.floor((Date.now() - val.createdAt) / 1000),
            routingSource: val.routingSource || null,
        })),
        contextWindows: {
            'claude-opus-4-7': getContextWindow('claude-opus-4-7'),
            'claude-opus-4-6': getContextWindow('claude-opus-4-6'),
            'claude-sonnet-4-6': getContextWindow('claude-sonnet-4-6'),
            'claude-haiku-4-5': getContextWindow('claude-haiku-4-5'),
        },
        activity: globalActivity.slice(-30),
        log: [...requestLog].reverse(),
    });
});

statusApp.post('/cleanup', requireDashboardAuth, requireCleanupCsrf, (req, res) => {
    const result = cleanupSessions(); // default: delete sessions older than 24h
    console.log(`[openclaw-claude-bridge] Manual cleanup: deleted ${result.deleted}, remaining ${result.remaining}`);
    res.json(result);
});

// SPA fallback — serve index.html for any non-API route. Express 5 uses
// path-to-regexp v8, where bare '*' is invalid; use middleware as the
// catch-all instead.
statusApp.use((req, res) => {
    res.sendFile(path.join(__dirname, '../dashboard/dist/index.html'));
});

module.exports = { statusApp };
