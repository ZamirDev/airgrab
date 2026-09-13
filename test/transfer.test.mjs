// transfer.test.mjs — pure-logic tests: chunking round-trip, messages.
// Run: node test/transfer.test.mjs   (no browser, no camera)

import { splitToChunks, joinChunks, newTransferId, startMsg, chunkMsgs, MAX_CHUNK } from '../src/transfer.js';

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

console.log('split/join round-trip');
for (const size of [0, 1, 100, MAX_CHUNK - 1, MAX_CHUNK, MAX_CHUNK + 1, 4.5 * MAX_CHUNK]) {
  const src = rnd(size);
  const parts = splitToChunks(src);
  const back = joinChunks(parts);
  const same = back.byteLength === src.byteLength &&
    new Uint8Array(back).every((v, i) => v === new Uint8Array(src)[i]);
  check(`size ${size}: ${parts.length} part(s) round-trips`, same, `backLen=${back.byteLength}`);
}

console.log('metadata & ids');
check('MAX_CHUNK <= 16384', MAX_CHUNK === 16384);
check('ids unique-ish', newTransferId() !== newTransferId());
const m = startMsg('abc', { name: 'x.png', mime: 'image/png', size: 10 }, 1);
check('startMsg carries name/mime/size/parts', m.name === 'x.png' && m.mime === 'image/png' && m.size === 10 && m.parts === 1);
const chunks = chunkMsgs('abc', rnd(MAX_CHUNK * 2 + 5));
check('chunkMsgs indexes seqs', chunks.length === 3 && chunks[0].i === 0 && chunks[2].i === 2 && chunks[1].data.byteLength === MAX_CHUNK);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);