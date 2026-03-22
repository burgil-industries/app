'use strict';
const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const APP_NAME    = '__APP_NAME__';
const APP_VERSION = '__APP_VERSION__';
const PORT        = 53420;
const WS_MAGIC    = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Rate limit: max 20 messages per 10-second window per remote address
const RATE_WINDOW = 10_000;
const RATE_MAX    = 20;
const rateLimits  = new Map();

function checkRate(ip) {
    const now = Date.now();
    let rl = rateLimits.get(ip);
    if (!rl || now > rl.reset) rl = { count: 0, reset: now + RATE_WINDOW };
    rl.count++;
    rateLimits.set(ip, rl);
    return rl.count <= RATE_MAX;
}

// Clean up stale rate-limit entries every minute
setInterval(() => {
    const now = Date.now();
    for (const [ip, rl] of rateLimits) if (now > rl.reset) rateLimits.delete(ip);
}, 60_000).unref();

// ── WebSocket frame codec ──────────────────────────────────────────────────────

function wsAccept(key) {
    return crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

function parseFrame(buf) {
    if (buf.length < 2) return null;
    const opcode    = buf[0] & 0x0f;
    if (opcode === 8) return null;              // connection close frame
    const isMasked   = !!(buf[1] & 0x80);
    let   payloadLen = buf[1] & 0x7f;
    let   offset     = 2;
    if      (payloadLen === 126) { payloadLen = buf.readUInt16BE(2);             offset = 4;  }
    else if (payloadLen === 127) { payloadLen = Number(buf.readBigUInt64BE(2));  offset = 10; }
    const maskStart = offset;
    const dataStart = offset + (isMasked ? 4 : 0);
    const data      = Buffer.from(buf.slice(dataStart, dataStart + payloadLen));
    if (isMasked) {
        const mask = buf.slice(maskStart, maskStart + 4);
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    }
    return data.toString('utf8');
}

function makeFrame(msg) {
    const payload = Buffer.from(msg, 'utf8');
    const len     = payload.length;
    let   header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81; header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81; header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
}

function send(socket, obj) {
    try { socket.write(makeFrame(JSON.stringify(obj))); } catch (_) {}
}

// ── Plugin registry ────────────────────────────────────────────────────────────

const pluginsFile = path.join(__dirname, '..', 'plugins.json');

function loadPlugins() {
    try { return JSON.parse(fs.readFileSync(pluginsFile, 'utf8')); }
    catch (_) { return {}; }
}

// ── Message handler ───────────────────────────────────────────────────────────

function handleMessage(socket, ip, raw) {
    if (!checkRate(ip)) {
        send(socket, { type: 'error', message: 'rate limited' });
        return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch (_) {
        send(socket, { type: 'error', message: 'invalid json' });
        return;
    }
    switch (msg.type) {
        case 'ping':
            send(socket, { type: 'pong', app: APP_NAME, version: APP_VERSION });
            break;
        case 'versions':
            send(socket, { type: 'versions', app: APP_NAME, version: APP_VERSION, plugins: loadPlugins() });
            break;
        default:
            send(socket, { type: 'error', message: 'unknown type' });
    }
}

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const server = http.createServer((req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(`${APP_NAME} ${APP_VERSION}`);
});

server.on('upgrade', (req, socket) => {
    const key    = req.headers['sec-websocket-key'];
    const accept = wsAccept(key);
    const ip     = socket.remoteAddress || 'unknown';

    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        'Access-Control-Allow-Origin: *\r\n' +
        '\r\n'
    );

    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        const msg = parseFrame(buf);
        if (msg !== null) {
            buf = Buffer.alloc(0);
            handleMessage(socket, ip, msg);
        }
    });
    socket.on('error', () => {});
});

server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
        console.log(`${APP_NAME}: port ${PORT} already in use - another instance may be running`);
    } else {
        console.error(`${APP_NAME}: server error: ${err.message}`);
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`${APP_NAME} ${APP_VERSION} - WS server listening on ws://127.0.0.1:${PORT}`);
});
