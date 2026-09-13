// index.js — AirGrab relay + static host.
//
// One origin serves:
//   1. the web app (sender/receiver pages + assets)  — over HTTPS on Railway,
//      so the phone's camera + WebSocket both work with no tunnel and no code
//   2. a tiny WebSocket room relay: clients join room = hash(public IP), so
//      every device on the same WiFi lands in the same room automatically.
//
// Protocol (JSON frames):
//   client -> relay  {t:'join', room, id, role, camera}
//   relay  -> client {t:'roster', room, peers:[{id, role, camera}]}   (to the joiner)
//   relay  -> client {t:'peer', room, peers:[]}                       (to everyone else)
//   relay  -> client {t:'peer-left', room, id, peers:[]}
//   client -> relay  {t:'msg', data}                                  (app envelope or base64 chunks)
//   relay  -> client {t:'msg', from, data}                            (to everyone else in the room)
//
// Dumb fan-out on purpose: peers only rely on the transport's shape, and the
// drop-ownership state machines live entirely in the browser.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.webm': 'video/webm',
  '.md': 'text/plain; charset=utf-8',
};

function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  let rel = pathname.replace(/^[/\\]+/, '');
  const allowed = path.join(ROOT, rel);
  if (!allowed.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  let file = allowed;
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch { /* 404 below */ }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

export function attachRelay(wss) {
  const rooms = new Map(); // room -> Map<ws, meta>
  const timer = setInterval(prune, 30_000);
  timer.unref?.();

  function peersOf(room, excludeWs) {
    const m = rooms.get(room);
    if (!m) return [];
    const out = [];
    for (const [ws2, inf] of m) {
      if (ws2 !== excludeWs) out.push({ id: inf.id, role: inf.role, camera: !!inf.camera });
    }
    return out;
  }
  function send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
  function broadcast(room, obj, excludeWs) {
    const m = rooms.get(room);
    if (!m) return;
    for (const ws2 of m.keys()) if (ws2 !== excludeWs) send(ws2, obj);
  }
  function join(ws, p) {
    leave(ws);
    const room = String(p.room || '').slice(0, 64);
    if (!room) return;
    ws.meta = {
      room,
      id: String(p.id || '').slice(0, 32) || 'c-' + Math.random().toString(36).slice(2, 9),
      role: p.role === 'receiver' ? 'receiver' : 'sender',
      camera: !!p.camera,
      lastSeen: Date.now(),
    };
    if (!rooms.has(room)) rooms.set(room, new Map());
    rooms.get(room).set(ws, ws.meta);
    send(ws, { t: 'roster', room, peers: peersOf(room, ws) });
    broadcast(room, { t: 'peer', room, peers: peersOf(room, undefined) });
  }
  function leave(ws) {
    if (!ws.meta) return;
    const room = ws.meta.room;
    rooms.get(room)?.delete(ws);
    if (rooms.get(room)?.size === 0) rooms.delete(room);
    broadcast(room, { t: 'peer-left', room, id: ws.meta.id, peers: peersOf(room, undefined) });
    ws.meta = null;
  }
  function handleMessage(raw, ws) {
    try { if (ws.meta) ws.meta.lastSeen = Date.now(); } catch { /* ignore */ }
    let p;
    try { p = JSON.parse(raw.toString()); } catch { return; }
    if (p.t === 'join') join(ws, p);
    else if (p.t === 'msg') {
      if (!ws.meta) return;
      broadcast(ws.meta.room, { t: 'msg', from: ws.meta.id, data: p.data ?? null });
    }
  }
  function prune() {
    const now = Date.now();
    for (const m of rooms.values()) {
      for (const [ws2, inf] of [...m]) {
        try { if (now - inf.lastSeen > 60_000) ws2.terminate(); } catch { /* ignore */ }
      }
    }
  }

  wss.on('connection', (ws) => {
    ws.meta = null;
    ws.on('message', (raw) => handleMessage(raw, ws));
    ws.on('close', () => leave(ws));
    ws.on('error', () => {});
  });
  return { rooms, stop() { clearInterval(timer); } };
}

export function createServer() {
  const httpServer = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 16 * 1024 * 1024 });
  attachRelay(wss);
  return httpServer;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const server = createServer();
  const port = process.env.PORT || 3001;
  server.listen(port, () => console.log(`airgrab relay + static on :${port}`));
}