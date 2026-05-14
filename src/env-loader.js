'use strict';

const fs = require('fs');
const path = require('path');

function repoRoot() {
    return path.resolve(__dirname, '..');
}

function stripInlineComment(value) {
    let quote = null;
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if ((ch === '"' || ch === "'") && value[i - 1] !== '\\') {
            quote = quote === ch ? null : (quote || ch);
        }
        if (ch === '#' && !quote) {
            const prev = value[i - 1];
            if (i === 0 || /\s/.test(prev)) {
                return value.slice(0, i).trimEnd();
            }
        }
    }
    return value;
}

function parseEnvValue(raw) {
    let value = stripInlineComment(raw.trim());
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            value = value.slice(1, -1);
            if (first === '"') {
                value = value
                    .replace(/\\n/g, '\n')
                    .replace(/\\r/g, '\r')
                    .replace(/\\t/g, '\t')
                    .replace(/\\"/g, '"')
                    .replace(/\\\\/g, '\\');
            }
        }
    }
    return value;
}

function loadEnvFile(envPath, env = process.env) {
    if (!envPath || !fs.existsSync(envPath)) {
        return { loaded: false, path: envPath || null, count: 0 };
    }

    const text = fs.readFileSync(envPath, 'utf8');
    let count = 0;
    for (const rawLine of text.split(/\r?\n/)) {
        let line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('export ')) line = line.slice('export '.length).trimStart();

        const eq = line.indexOf('=');
        if (eq <= 0) continue;

        const key = line.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        if (Object.prototype.hasOwnProperty.call(env, key)) continue;

        env[key] = parseEnvValue(line.slice(eq + 1));
        count++;
    }
    return { loaded: true, path: envPath, count };
}

function loadDefaultEnv(env = process.env) {
    const envPath = env.OPENCLAW_BRIDGE_ENV_FILE
        ? path.resolve(env.OPENCLAW_BRIDGE_ENV_FILE)
        : path.join(repoRoot(), '.env');
    return loadEnvFile(envPath, env);
}

module.exports = { loadDefaultEnv, loadEnvFile, parseEnvValue };
