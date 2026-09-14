// relay.test.mjs — AutoRoom relay: roster presence + base64 chunk fan-out.
// Run: node test/relay.test.mjs

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { attachRelay } from '../server/index.js';
import { splitToChunks, encodeForWire, decodeFromWire, bytesToB64, b64ToBytes, createRelayTransport } from '../src/transfer.js';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
check('sender B is NOT echoed its own msg', !B.events.some((m) => m.t === 'msg' && m.from === 'b'));

B.close();
await new Promise((r) => setTimeout(r, 120));
check('A is told B left', A.events.some((m) => m.t === 'peer-left' && m.id === 'b'));

console.log('b64 helpers (standalone)');
const b = rnd(70_000);
check('bytesToB64 / b64ToBytes round-trip', new Uint8Array(b64ToBytes(bytesToB64(b))).every((v, i) => v === new Uint8Array(b)[i]));

console.log('preview round-trip over relay (encodeForWire / decodeFromWire)');
const pChunk = { id: 'tid-2', i: 0, total: 1, data: splitToChunks(rnd(16384))[0], preview: rnd(5000) };
const pw = encodeForWire(pChunk);
check('data + preview both encoded', typeof pw.dataB64 === 'string' && typeof pw.previewB64 === 'string');
const pd = decodeFromWire(pw);
check('data + preview decode back identically', new Uint8Array(pd.data).every((v, i) => v === new Uint8Array(pChunk.data)[i]) && new Uint8Array(pd.preview).every((v, i) => v === new Uint8Array(pChunk.preview)[i]));

console.log('relay reconnect (transport-level reconnect after socket drop)');
const reconnRoom = 'ag-reconn-test';
const r1 = createRelayTransport({ url, room: reconnRoom });
const r2 = createRelayTransport({ url, room: reconnRoom });
const r1Ev = [];
await r1.open('sender', { onMessage: (m) => r1Ev.push(m) });
await r2.open('receiver', { onMessage: () => {} });
r2.send({ t: 'hello', poke: 1 });
await sleep(350);
check('r1 got initial poke before drop', r1Ev.some((m) => m.t === 'hello' && m.poke === 1));
const r1ws = r1._ws;
r1ws.close();   // simulate phone network drop — transport will reconnect
await sleep(1800);   // backoff 1 s + join round-trip
r2.send({ t: 'hello', poke: 2 });
await sleep(400);
check('r1 reconnected and received poke2', r1Ev.some((m) => m.t === 'hello' && m.poke === 2));
r1.close(); r2.close();

relay.stop();
wss.close();
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);