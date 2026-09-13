// interlock.test.mjs — sender/receiver drop-ownership state machines.
// Run: node test/interlock.test.mjs

import { createSenderInterlock, createReceiverInterlock, DROP_WINDOW_MS, ACK_TIMEOUT_MS } from '../src/interlock.js';
import { holdingMsg, dropMsg, nothingHeldMsg, ackMsg } from '../src/transfer.js';

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}  ${detail}`); }
}

const send = [], cancelled = [], done = [];
let waitStarts = 0;
const p = { _id: 'x1', name: 'cat.svg', mime: 'image/svg+xml', size: 42, data: new Uint8Array(42).buffer };

function makeSender(camera) {
  const s = createSenderInterlock({
    onSend: (pl) => send.push(pl),
    onWaitDropStart: () => { waitStarts++; },
    onCancel: (pl) => cancelled.push(pl),
    onDone: (pl) => done.push(pl),
  });
  s.setReceiver({ camera });
  return s;
}

function resetAll() { send.length = 0; cancelled.length = 0; done.length = 0; waitStarts = 0; }

console.log('sender FSM — no-camera receiver (sender-side release sends immediately)');
{
  resetAll();
  const s = makeSender(false);
  check('grab on idle enters holding', s.grab(p) === true && s.state === 'holding');
  check('second grab while holding is rejected', s.grab({ ...p, _id: 'x2' }) === false);
  s.ownRelease();
  check('ownRelease with no camera -> sending + onSend once', s.state === 'sending' && send.length === 1 && send[0]._id === 'x1');
  s.ack();
  check('ack -> idle + onDone once', s.state === 'idle' && done.length === 1 && done[0].name === 'cat.svg');
  s.ack();
  check('extra ack is ignored', done.length === 1);
}

console.log('\nsender FSM — camera receiver (sender holds until laptop drop)');
{
  resetAll();
  const s = makeSender(true);
  s.grab(p);
  s.ownRelease();
  check('ownRelease with camera -> waitingDrop (no send yet)', s.state === 'waitingDrop' && send.length === 0);
  check('onWaitDropStart fired once', waitStarts === 1);
  s.ownRelease();
  check('repeat ownRelease while waiting is quiet', send.length === 0 && waitStarts === 1);
  check('dropFromReceiver -> sending', s.dropFromReceiver() === 'sent' && s.state === 'sending' && send.length === 1);
  s.ack();
  check('ack after drop -> idle + done', s.state === 'idle' && done.length === 1);
}

console.log('\nsender FSM — holding waits, then the window lapses (cancel)');
{
  resetAll();
  const s = makeSender(true);
  s.grab(p);
  s.ownRelease();
  s.cancel();
  check('cancel from waitingDrop -> idle + onCancel', s.state === 'idle' && cancelled.length === 1 && cancelled[0]._id === 'x1');
  check('cancel again is a no-op', cancelled.length === 1);
}

console.log('\nsender FSM — drop arrives while still holding (no local release yet)');
{
  resetAll();
  const s = makeSender(true);
  s.grab(p);
  check('dropFromReceiver while holding -> sending', s.dropFromReceiver() === 'sent' && s.state === 'sending');
}

console.log('\nsender FSM — spurious / out-of-order guards');
{
  resetAll();
  const s = makeSender(true);
  check('drop with nothing held -> nothing', s.dropFromReceiver() === 'nothing' && s.state === 'idle');
  check('abort from idle -> null', s.abort() === null);
  s.grab(p);
  const aborted = s.abort();
  check('abort from holding returns payload + idle', aborted && aborted._id === 'x1' && s.state === 'idle');
  check('ownRelease after abort is a no-op', send.length === 0 && s.state === 'idle');
}

console.log('\nreceiver FSM');
{
  let drops = [], holdings = 0, dones = 0;
  const r = createReceiverInterlock({
    onHolding: () => holdings++,
    onDrop: (h) => drops.push(h),
    onDone: () => dones++,
  });
  r.holding(p);
  check('holding -> state holding + onHolding', r.state === 'holding' && holdings === 1);
  r.holding({ ...p, _id: 'x9' });
  check('second holding while already holding is ignored', holdings === 1);
  r.cameraRelease();
  check('cameraRelease -> waiting, one drop emitted', r.state === 'waiting' && drops.length === 1 && drops[0]._id === 'x1');
  r.cameraRelease();
  check('repeat cameraRelease is silent', drops.length === 1);
  r.done();
  check('done -> idle + onDone once', r.state === 'idle' && dones === 1);
  r.cameraRelease();
  check('cameraRelease with nothing held is silent', drops.length === 1);
  r.holding(p);
  r.done();
  check('holding after done works again', r.state === 'idle' && holdings === 2);
}

console.log('\nprotocol helpers');
{
  const held = { _id: 'x99', name: 'night.svg', mime: 'image/svg+xml', size: 12 };
  const h = holdingMsg(held, new Uint8Array([1, 2, 3]).buffer);
  check('holdingMsg carries id/name/mime/size + preview bytes', h.t === 'holding' && h.id === 'x99' && h.name === 'night.svg' && h.size === 12 && h.preview.byteLength === 3 && h.previewMime === 'image/jpeg');
  const d = dropMsg('x99');
  check('dropMsg locks forId', d.t === 'drop' && d.forId === 'x99');
  check('nothingHeldMsg + ackMsg shapes', nothingHeldMsg('x99').forId === 'x99' && ackMsg('x99').id === 'x99');
}

console.log('\nconstants sane');
check('DROP_WINDOW_MS in [600, 4000]', DROP_WINDOW_MS >= 600 && DROP_WINDOW_MS <= 4000);
check('ACK_TIMEOUT_MS in [2000, 20000]', ACK_TIMEOUT_MS >= 2000 && ACK_TIMEOUT_MS <= 20000);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);