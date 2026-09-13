// relay.test.mjs — AutoRoom relay: roster presence + base64 chunk fan-out.
// Run: node test/relay.test.mjs

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { attachRelay } from '../server/index.js';
import { splitToChunks, encodeForWire, decodeFromWire, bytesToB64, b64ToBytes } from '../src/transfer.js';

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}  ${detail}`); }
}

const rnd = (n) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0;
  return b.buffer;
};

const server = http.createServer();
const wss = new WebSocketServer({ server });
const relay = attachRelay(wss);
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = `ws://127.0.0.1:${port}`;

function client(id, role) {
  const c = new WebSocket(url);
  c.sent = [];
  c.events = [];
  c.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    c.events.push(m);
    c.sent.push(raw.toString());
  });
  return new Promise((res, rej) => { c.on('open', () => res(c)); c.on('error', rej); });
}

const A = await client('a', 'sender');
const B = await client('b', 'receiver');
A.send(JSON.stringify({ t: 'join', room: 'ag-TEST', id: 'a', role: 'sender' }));

await new Promise((r) => setTimeout(r, 120));

check('joiner A gets roster (empty)', A.events.some((m) => m.t === 'roster' && m.peers.length === 0));

B.send(JSON.stringify({ t: 'join', room: 'ag-TEST', id: 'b', role: 'receiver' }));
await new Promise((r) => setTimeout(r, 120));

check('newcomer B sees A in roster', B.events.some((m) => m.t === 'roster' && m.peers.some((p) => p.id === 'a' && p.role === 'sender')));
check('A is told a peer joined', A.events.some((m) => m.t === 'peer' && m.peers.some((p) => p.id === 'b' && p.role === 'receiver')));

const payload = rnd(40_000); // spans multiple MAX_CHUNK parts
const chunk = { id: 'tid-1', i: 0, total: 3, data: splitToChunks(payload)[0] };
const wire = encodeForWire(chunk);
check('chunk encoded to dataB64 string', typeof wire.dataB64 === 'string');
B.send(JSON.stringify({ t: 'msg', data: wire }));

await new Promise((r) => setTimeout(r, 120));
const got = A.events
  .filter((m) => m.t === 'msg' && m.from === 'b')
  .map((m) => decodeFromWire(m.data));

check('B->A chunk round-trips identically', got.length === 1 &&
  new Uint8Array(got[0].data).every((v, i) => v === new Uint8Array(chunk.data)[i]) &&
  got[0].id === 'tid-1');

B.close();
await new Promise((r) => setTimeout(r, 120));
check('A is told B left', A.events.some((m) => m.t === 'peer-left' && m.id === 'b'));

console.log('b64 helpers (standalone)');
const b = rnd(70_000);
check('bytesToB64 / b64ToBytes round-trip', new Uint8Array(b64ToBytes(bytesToB64(b))).every((v, i) => v === new Uint8Array(b)[i]));

relay.stop();
wss.close();
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);