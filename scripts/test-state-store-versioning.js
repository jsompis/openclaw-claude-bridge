'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-state-store-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-state-home-'));
const stateFile = path.join(stateDir, 'state.json');
const sessionsDir = path.join(
    homeDir,
    '.claude/projects',
    '-' + fs.realpathSync('/tmp').replace(/\//g, '-').replace(/^-/, '')
);

function touchSession(sessionId) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), '{}\n');
}

function runNode(source) {
    const result = spawnSync(process.execPath, ['-e', source], {
        cwd: repoRoot,
        env: {
            ...process.env,
            HOME: homeDir,
            OPENCLAW_BRIDGE_STATE_DIR: stateDir,
        },
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim().split('\n').filter(Boolean);
}

function runJson(source) {
    const lines = runNode(source);
    assert.ok(lines.length > 0, 'child process produced no stdout');
    return JSON.parse(lines[lines.length - 1]);
}

function writeState(data) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(data));
}

try {
    touchSession('save-session');
    runNode(`
        const store = require('./src/state-store');
        const longKey = 'This saved response map key is sufficiently distinctive and should survive persistence.';
        store.channelMap.set('route:save', { sessionId: 'save-session', createdAt: 1, routingSource: 'test' });
        store.sessionMap.set('tool-save', { sessionId: 'save-session', createdAt: 2 });
        store.responseMap.set(longKey, { sessionId: 'save-session', createdAt: 3 });
        store.pushLog({ id: 'request-save' });
        store.pushActivity('request-save', 'saved activity');
        store.saveState();
    `);
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(saved.schemaVersion, 1);
    assert.ok(Array.isArray(saved.channelMap));
    assert.ok(Array.isArray(saved.sessionMap));
    assert.ok(Array.isArray(saved.responseMap));
    assert.ok(Array.isArray(saved.requestLog));
    assert.ok(Array.isArray(saved.globalActivity));

    touchSession('legacy-session');
    const longLegacyKey = 'This legacy response map key is sufficiently distinctive and should survive normalization during migration.';
    writeState({
        stats: { totalRequests: 7, errors: 2 },
        channelMap: [['route:legacy', { sessionId: 'legacy-session', createdAt: 10, routingSource: 'legacy' }]],
        sessionMap: [['tool-legacy', { sessionId: 'legacy-session', createdAt: 11 }]],
        responseMap: [
            ['NO_REPLY', { sessionId: 'legacy-session', createdAt: 12 }],
            ['HEARTBEAT_OK', { sessionId: 'legacy-session', createdAt: 13 }],
            ['short unsafe key', { sessionId: 'legacy-session', createdAt: 14 }],
            [`  ${longLegacyKey}\nwith   extra   whitespace  `, { sessionId: 'legacy-session', createdAt: 15 }],
        ],
        requestLog: [{ id: 'legacy-request' }],
        globalActivity: [{ id: 'legacy-activity' }],
    });
    const legacy = runJson(`
        const store = require('./src/state-store');
        console.log(JSON.stringify({
            schema: store.STATE_SCHEMA_VERSION,
            totalRequests: store.stats.totalRequests,
            errors: store.stats.errors,
            channel: store.channelMap.get('route:legacy'),
            session: store.sessionMap.get('tool-legacy'),
            responseEntries: Array.from(store.responseMap.entries()),
            requestLog: store.requestLog,
            globalActivity: store.globalActivity,
        }));
    `);
    assert.equal(legacy.schema, 1);
    assert.equal(legacy.totalRequests, 7);
    assert.equal(legacy.errors, 2);
    assert.equal(legacy.channel.sessionId, 'legacy-session');
    assert.equal(legacy.session.sessionId, 'legacy-session');
    assert.equal(legacy.requestLog.length, 1);
    assert.equal(legacy.globalActivity.length, 1);
    assert.equal(legacy.responseEntries.length, 1);
    assert.equal(
        legacy.responseEntries[0][0],
        `${longLegacyKey} with extra whitespace`
    );

    touchSession('future-session');
    writeState({
        schemaVersion: 999,
        channelMap: [['route:future', { sessionId: 'future-session', createdAt: 20 }]],
        responseMap: [['This future response map key is sufficiently distinctive and should load best-effort.', { sessionId: 'future-session', createdAt: 21 }]],
        requestLog: [{ id: 'future-request' }],
    });
    const future = runJson(`
        const store = require('./src/state-store');
        console.log(JSON.stringify({
            channel: store.channelMap.get('route:future'),
            responseSize: store.responseMap.size,
            requestLogLength: store.requestLog.length,
        }));
    `);
    assert.equal(future.channel.sessionId, 'future-session');
    assert.equal(future.responseSize, 1);
    assert.equal(future.requestLogLength, 1);

    writeState(null);
    runNode(`require('./src/state-store'); console.log('invalid-ok');`);
} finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
}

console.log('state-store versioning tests passed');
